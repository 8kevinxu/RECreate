/*
 * Shared class-title pre-translation (extracted from build-classes.js so the
 * per-city class builders reuse it). Titles are scraped English; the app UI is
 * translated (en/zh/es), so we pre-translate the *distinct* titles once and
 * bundle name_zh/name_es onto each row — the app stays instant/offline and
 * never calls an API. Translations are cached by title in the caller's cache
 * file, so each refresh only spends tokens on titles it hasn't seen — usually
 * zero. Degrades gracefully: with no ANTHROPIC_API_KEY (or on any API error)
 * we keep the English names and move on.
 */

const fs = require('fs');
const { fetchT } = require('../fetch-timeout');

// Translate one chunk of titles via Claude Haiku. Returns { title: { zh, es } }.
async function translateChunk(names, contextLine) {
  const list = names.map((n, i) => `${i + 1}. ${n}`).join('\n');
  const prompt =
    `Translate these ${names.length} ${contextLine} ` +
    `into Simplified Chinese and Spanish. They are recreational classes (fitness, ` +
    `dance, art, music, social games). Keep translations natural and concise and ` +
    `preserve level markers like "Intermediate"/"Beginner". Reply with ONLY a JSON ` +
    `array of exactly ${names.length} objects, same order, each {"zh":"…","es":"…"} ` +
    `— no prose, no code fences.\n\n${list}`;
  const res = await fetchT('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
  const out = {};
  names.forEach((n, i) => {
    const t = arr[i];
    if (t && t.zh && t.es) out[n] = { zh: String(t.zh), es: String(t.es) };
  });
  return out;
}

// Add name_zh/name_es to each class from cacheFile, translating new titles first.
// contextLine describes the titles in the prompt, e.g.
// "San Francisco Rec & Park drop-in class titles".
async function applyTranslations(classes, { cacheFile, contextLine }) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {}
  const distinct = [...new Set(classes.map((c) => c.name))];
  const missing = distinct.filter((n) => !cache[n]);

  if (missing.length) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log(`  ⚠ ANTHROPIC_API_KEY not set — ${missing.length} title(s) stay English-only`);
    } else {
      console.log(`  Translating ${missing.length} new class title(s) via Claude Haiku…`);
      try {
        for (let i = 0; i < missing.length; i += 40) {
          Object.assign(cache, await translateChunk(missing.slice(i, i + 40), contextLine));
        }
        fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + '\n');
      } catch (e) {
        console.log(`  ⚠ translation skipped (${e.message}) — keeping English titles`);
      }
    }
  }

  for (const c of classes) {
    const t = cache[c.name];
    if (t) {
      c.name_zh = t.zh;
      c.name_es = t.es;
    }
  }
}

module.exports = { applyTranslations };
