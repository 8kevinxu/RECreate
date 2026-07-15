---
name: verify
description: How to run and drive the RECreate web app for runtime verification of changes.
---

# Verifying RECreate changes (web surface)

There is no test suite; verification means driving the running app.

## Launch

```bash
CI=1 npx expo start --web --port 8082 > /tmp/expo-server.log 2>&1 &
# wait for: curl -s -o /dev/null -w "%{http_code}" http://localhost:8082/  → 200
```

Don't pipe the server's stdout through `head`/`tail -n` — the closed pipe
SIGPIPE-kills Metro mid-session. Redirect to a file. First page hit compiles
the web bundle (~30–60 s); do a warm-up load before timing-sensitive steps.

## Drive (headless Chrome via Playwright)

Install `playwright` in the scratchpad and launch with `channel: 'chrome'` —
system Chrome, no browser download. Useful facts:

- AsyncStorage on web is plain `localStorage`, raw keys (e.g.
  `recreate.onboarded.v1`). Seed `'1'` via `addInitScript` to skip onboarding;
  leave unset to test the onboarding overlay.
- The app mirrors view state into the query string (`lib/urlState.web.js`) —
  asserting on `window.location.search` after boot is a cheap way to check
  routing (e.g. `?tab=profile`).
- Signed-in flows: don't create accounts against prod Supabase. Stub the API
  with `ctx.route(SUPabase_URL + '/**')`: fulfill `/auth/v1/token` with a
  fake session (JWT only needs a well-formed base64url payload with future
  `exp` — signature is never checked client-side), `/rest/v1/profiles` with a
  profile row (return a bare object when the request's Accept header contains
  `pgrst.object`, else an array), other tables `[]`. Then sign in through the
  real UI (placeholders "Email" / "Password", last exact-text "Sign in").
- `navigator.share` exists in modern desktop Chrome, and in headless it hangs
  forever — to exercise a Share fallback path, `delete
  window.Navigator.prototype.share` in `addInitScript`.
- Grant `clipboard-read`/`clipboard-write` on the context to observe
  clipboard writes.
- To verify a rendered QR code, screenshot and decode with `jsqr` + `pngjs`.

Give effects ~2–3 s to settle after navigation (storage reads, routing,
Supabase round-trips) before asserting.

## Also

`npm run check` is the CI parse/i18n-parity/data-floor gate — run it, but it
is not verification.
