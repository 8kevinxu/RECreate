// Friend-invite links: a shareable URL that opens the web app with ?add=<code>
// so the recipient lands with a friend request one tap away (App.js picks the
// param up from lib/urlState and hands it to FriendsModal). The origin is the
// deployed web app — keep in sync with SITE in scripts/postbuild-web.js.
const INVITE_ORIGIN = 'https://recreate-sf.vercel.app';

// Friend codes are 6 chars from an unambiguous alphabet (no 0/O/1/I/L) — see
// gen_friend_code() in supabase/schema/03_profiles.sql. Parse leniently
// (any 6 alphanumerics, case-insensitive) so a hand-typed URL still works.
export function parseInviteCode(raw) {
  const clean = (raw || '').trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(clean) ? clean : null;
}

export function inviteUrl(code) {
  return `${INVITE_ORIGIN}/?add=${encodeURIComponent(code)}`;
}
