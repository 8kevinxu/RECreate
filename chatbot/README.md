# The RECreate assistant

A small **FastAPI** service that answers questions about courts, pools and
classes — "is Rossi open tomorrow?", "cheapest beginner tennis class in the
Mission", "how busy is Hamilton right now?" — from the app's own data.

It is a **separate process, not part of the app bundle**. The app talks to this
service; this service talks to a model. That split exists for one reason: the
model provider key stays server-side and never reaches a phone.

```
  app (lib/assistant.js)  ──HTTP──▶  chatbot/ (this service)  ──▶  Ollama | Anthropic
   gated on                            retrieval in Python          picks a tool,
   EXPO_PUBLIC_ASSISTANT_URL           = the only source of facts    writes a sentence
```

---

## The one rule

**Retrieval is deterministic Python. The model never decides a fact.**

The model picks a tool, fills its arguments, and phrases the result. It cannot
decide whether a court is open, so it cannot invent an opening that was never in
the data. Everything else here follows from that:

- **Payloads are narrow.** A court's reserved-slots table is ~3KB of per-half-hour
  data; shipping it next to the opening hours buried them and produced "check the
  app for fees" *with the fees in context*. Tools project down to the numbers
  worth stating.
- **Keys are named for what they answer.** `miles_from_user`, not `miles`;
  `percent_booked_at_asked_time`, not `percent_booked`. A well-named key
  outperforms a system-prompt rule saying the same thing, because the prompt is
  obeyed inconsistently by a small model and the key is not.
- **Absence is not a No.** A field that was never recorded comes back as an
  explicit `UNKNOWN` note, so "which courts have a hitting wall?" in a city that
  doesn't track them can't be answered "none".
- **Dates are resolved in Python.** `when="saturday"` becomes a real moment in the
  city's timezone before the model sees it, so it never does calendar arithmetic.

---

## Files

| File | Responsibility |
|---|---|
| `data.py` | Loads the snapshots, builds indexes, owns city timezones |
| `timeutil.py` | Resolves `when` to a moment; reads a week at that moment |
| `retrieval.py` | The seven tools — **the only source of facts** |
| `tools.py` | JSON Schema, argument sanitising, dispatch |
| `llm.py` | One provider seam over Ollama and Anthropic |
| `agent.py` | The tool-calling loop, its guardrails, and the system prompt |
| `limits.py` | Per-caller rate limits and the global daily budget |
| `app.py` | `GET /health`, `POST /chat`, auth |

**Tools:** `find_courts` · `summarize_courts` · `get_court` ·
`get_reservation_policy` · `find_classes` · `get_pool_info` · `list_options`.

`summarize_courts` exists because `find_courts` caps at 25 rows and the model was
reading superlatives off a truncated list — "everything closes at 8PM" (one place
ran to 8:50), "Mission and Glen Park have weight rooms but not basketball" (both
have basketball). It computes over every record and reports ties as ties.

---

## Run it

The service reads **snapshots exported from the app's generated data**, so export
them first — they're gitignored, and a fresh clone has none.

```bash
npm run export:chatbot                 # from the repo root → chatbot/data/*.json

cd chatbot
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env                   # then edit (see below)

.venv/bin/python -m uvicorn app:app --port 8000
```

Then point the app at it in the **repo root** `.env`:

```bash
EXPO_PUBLIC_ASSISTANT_URL=http://localhost:8000
npx expo start -c                      # -c is required after changing .env
```

Use your Mac's LAN IP rather than `localhost` for a physical device. Unset the
var and the assistant vanishes from the app entirely — which is what production
ships.

**Check it's actually wired up:** `curl localhost:8000/health`. The response is
deliberately more than `{"ok":true}` — the things that break in practice are
missing snapshots, an unreachable model backend, the service quietly running a
different model than you assumed, and (once deployed) a spent daily budget. All
four are visible there. It stays unauthenticated even when a token is set: it
makes no model call, so it can't be used to spend anything, and an uptime check
that needs a credential is an uptime check that gets turned off.

### Providers

Set `ASSISTANT_PROVIDER` to `ollama` (free, local, offline) or `anthropic`
(hosted). See `.env.example` for the full set of knobs.

- **Ollama** needs a model with **tool support** — check with `ollama show <model>`.
  `gemma3` has none; a 3B like `llama3.2` runs but under-reports. `llama3.1:8b` is
  the default and takes **20–45s** for a question needing a tool call, which is
  why the client's fetch timeout is 90s.
- **Anthropic** defaults to `claude-haiku-4-5` at `ANTHROPIC_EFFORT=low`, and the
  workload is why. Every fact in an answer was already retrieved by Python; the
  model chooses a tool, fills its arguments, and writes one sentence around the
  result. That is not where a frontier model earns its price. Set
  `ANTHROPIC_MODEL=claude-opus-5` when a specific answer is bad and you want to
  find out whether the model is the reason — it usually isn't, and the fix is
  usually a tool returning a differently-shaped payload.

`ANTHROPIC_API_KEY` is server-side only and never appears in `/health`.

---

## Tests

```bash
cd chatbot && .venv/bin/python -m pytest -q      # 429 tests, ~1s
```

They cover the tools, the clock, the loop and the endpoints, and the suite
**freezes time** so its pinned dates stay valid as the calendar moves. Note that
the repo's CI (`npm run check`) does **not** run them — it only gates the JS app.
Run them by hand when touching this directory.

---

## Refreshing the data

`npm run export:chatbot` (`scripts/export-chatbot-data.js`) is the bridge between
the app's generated `data/` modules and this service. It is the only place that
knows how a court is assembled: it reproduces `lib/useCourts.js`'s merge (union
every source, attach rec.us booked-%, honour a posted `playWeek`) and resolves
each sport's week by calling the app's **own** `lib/hours.js` logic rather than
reimplementing it — which is why `resolveDropinWeek()` is exported from there.
Re-run it after any data refresh; the snapshots are point-in-time.

Output is three JSON files in `chatbot/data/` (courts, classes, reference), with
a loose sanity gate that exits non-zero if too few courts survive — the same
live → cache → curated resilience posture the build scripts use.

---

## Before this ever leaves localhost

**Every answered question costs a model call**, so the thing that needs bounding
here is not load but money. The controls exist; they default to off, because
requiring a token to run this on your own laptop is the kind of friction that
ends with a token committed to the repo. Boot logs a warning in that posture, so
a deployment with the dev defaults still in place announces itself.

| Setting | Default | Set it to |
|---|---|---|
| `ASSISTANT_TOKEN` | unset (open) | a random string, also set as `EXPO_PUBLIC_ASSISTANT_TOKEN` in the repo-root `.env` |
| `ASSISTANT_ALLOWED_ORIGINS` | `*` | the web build's real origin |
| `ASSISTANT_RATE_PER_MIN` / `_PER_DAY` | 6 / 100 | per-caller, keyed by IP |
| `ASSISTANT_DAILY_BUDGET` | 1000 | questions/day across **everyone** |
| `ASSISTANT_TRUST_PROXY` | `false` | `true` only behind a proxy that sets `X-Forwarded-For` |

Three things about that table are worth understanding rather than copying:

**The token is not a secret.** It ships inlined in the app bundle — it has to,
since the client is what presents it — and a bundle can be read out of any
downloaded app. It removes drive-by traffic, which is most of what an open
endpoint attracts, and it stops nothing more determined. Don't let its presence
imply the endpoint is private.

**The daily budget is the control that actually bounds the bill.** Per-IP limits
are defeated by definition by a distributed caller. The global window doesn't
care how many identities are involved, only how many questions have been
answered — which is the thing being paid for. Set it to a number of requests
you'd be content to pay for on your worst day, because that is exactly what it
buys. When it's exhausted `/health` goes `degraded` and says so, so "why did it
stop answering?" doesn't require reading logs.

**`ASSISTANT_TRUST_PROXY=true` without a proxy is a bypass, not a hardening.**
`X-Forwarded-For` is caller-supplied text; trusting it with nothing in front lets
anyone mint a fresh identity per request.

Belt and braces on the provider side: use a key from a **dedicated Anthropic
workspace with its own spend limit**, so a runaway here can't reach the credits
`npm run build:classes` depends on, and so revoking it costs you nothing else.
The service's budget is a ceiling it enforces on itself; the workspace limit is
the one that holds when the service is the thing that's wrong.

Token counts are logged on every answer (`in=… out=… cached=…`), not only in
debug mode — the question they answer is always asked about traffic that has
already happened.

Two design notes worth preserving if you touch `app.py`:

**The handlers are sync `def` on purpose.** `agent.answer()` blocks for seconds,
and FastAPI runs a sync handler in a worker thread, so concurrent requests
proceed. Wrapping blocking calls in `async def` would freeze the event loop for
the whole process on every question and serialise all users behind one model call
— the easiest way to make a service like this appear to hang under light load.

**Limit state is in-memory and per-process.** Two workers means two independent
budgets and a restart forgives every counter. For a single-process service that
is right, and reaching for Redis to fix it would put a network dependency in the
request path of a service whose point is to run simply. Scale past one worker and
this has to move to shared storage.

**One invariant this service owes the app.** `lib/assistant.js` posts the user's
coordinates so distances can be measured. They are used for a haversine and
dropped — never persisted, never logged, and **never sent to the model** (`origin`
is keyword-only and absent from the tool schemas; the model sees
`miles_from_user`). That is what keeps the app's App Store privacy label able to
say *Location: Not Collected*, under Apple's exemption for data held no longer
than needed to service a request in real time.

It is a convention, not something the type system protects, and a single
`log.info("state=%s", state)` added while debugging would falsify a store listing
with no visible symptom. So it's pinned by tests —
`TestCoordinatesStayInsideTheRequest` in `tests/test_agent.py` and
`TestRequestLogging` in `tests/test_app.py`. If you ever need to break it, read
`docs/privacy-nutrition-label.md` first: the manifest and the ASC answers change
with it. Users' *questions* do go to the model provider, which is why the policy
has to disclose the assistant when a build enables it.
