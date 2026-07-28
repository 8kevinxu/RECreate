// Answers to app questions that need no model and no network.
//
// The assistant's knowledge of the app itself is static text — it lives in
// APP_FACTS inside the service's system prompt, which means "how do I save a
// favorite?" needed a live model call to answer a question whose answer never
// changes. When the service was unreachable or the model was down, the user got
// an error instead of two sentences the phone was already holding.
//
// So the same facts live here, on the client, and are used whenever a question
// cannot be sent: service not running, request timed out, model backend down, or
// the feature not configured in this build. That covers strictly more failure
// modes than a server-side fallback could, and keeps one copy of the facts.
//
// What it deliberately does NOT do is answer questions about courts, pools,
// classes, hours or prices. Those are live data and the honest answer when the
// assistant is down is "I can't check that right now" — inventing a court from
// the phone's cache is the exact failure the whole grounded design exists to
// prevent. This only answers questions about how the app works.

// Casefold and flatten punctuation so "How do I un-star a court?" and "how do i
// unstar a court" match the same terms. Accents are stripped for Spanish, where
// users routinely type "cuanto" for "cuánto".
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// One entry per topic. `id` resolves to two i18n keys:
//   assistant.faq.<id>.k  pipe-separated match terms, per language
//   assistant.faq.<id>.a  the answer, per language
// Keeping the terms in i18n means each language matches its own vocabulary
// rather than English keywords transliterated badly.
export const TOPICS = [
  'coverage', // what the app is, which cities
  'map', // the map, sport switcher, open vs closed markers
  'favorites', // starring a place
  'classes', // the Classes tab and registering
  'pools', // pools are a sport on the map, SF only
  'social', // planning a session, "down to play"
  'account', // what needs an account, what works signed out
  'languages', // English / Chinese / Spanish
];

// A term matches as a whole word when it is Latin script, and as a plain
// substring otherwise. Chinese has no spaces, so a word-boundary test would
// never fire; English needs one, or "star" matches "start" and every question
// containing "starting" is answered with the favorites text.
const LATIN = /^[\w\s'-]+$/;

function hits(haystack, term) {
  if (!term) return false;
  if (!LATIN.test(term)) return haystack.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

// Best-matching topic for a question, or null when nothing is close enough.
// Returning null matters as much as returning an answer: a wrong confident
// answer while the assistant is down is worse than saying it's down.
export function matchTopic(question, t) {
  const asked = normalize(question);
  if (!asked) return null;

  // A question about live data is refused even when it mentions a topic word.
  // "How much does the pool cost today?" matches the pools topic on "pool", and
  // answering it offline would dodge the question that was actually asked with
  // text about where pools live in the UI. Hours, prices and availability need
  // the service, and saying so is the honest answer.
  const live = String(t('assistant.offline.liveTerms') || '')
    .split('|')
    .map((term) => normalize(term))
    .filter(Boolean);
  if (live.some((term) => hits(asked, term))) return null;

  let best = null;
  for (const id of TOPICS) {
    const terms = String(t(`assistant.faq.${id}.k`) || '')
      .split('|')
      .map((term) => normalize(term))
      .filter(Boolean);
    const score = terms.reduce((n, term) => n + (hits(asked, term) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { id, score };
  }
  return best ? best.id : null;
}

// The offline answer for a question, or null if we have nothing honest to say.
export function answerOffline(question, t) {
  const id = matchTopic(question, t);
  if (!id) return null;
  const answer = t(`assistant.faq.${id}.a`);
  return answer ? { id, answer } : null;
}
