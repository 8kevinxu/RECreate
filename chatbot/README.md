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
| `app.py` | `GET /health`, `POST /chat` |

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
deliberately more than `{"ok":true}` — the three things that break in practice
are missing snapshots, an unreachable model backend, and the service quietly
running a different model than you assumed. All three are visible there.

### Providers

Set `ASSISTANT_PROVIDER` to `ollama` (free, local, offline) or `anthropic`
(hosted). See `.env.example` for the full set of knobs.

- **Ollama** needs a model with **tool support** — check with `ollama show <model>`.
  `gemma3` has none; a 3B like `llama3.2` runs but under-reports. `llama3.1:8b` is
  the default and takes **20–45s** for a question needing a tool call, which is
  why the client's fetch timeout is 90s.
- **Anthropic** defaults to `claude-opus-5` at `ANTHROPIC_EFFORT=low`. The
  reasoning is already done in Python — the model only picks a tool and writes a
  sentence — so low effort suits the workload, and a smaller model is a
  reasonable economy (`ANTHROPIC_MODEL=claude-haiku-4-5`).

`ANTHROPIC_API_KEY` is server-side only and never appears in `/health`.

---

## Tests

```bash
cd chatbot && .venv/bin/python -m pytest -q      # 388 tests, ~1s
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

As written the service has **no authentication, no rate limiting, and wide-open
CORS** (`allow_origins=["*"]`), and every request costs a model call. That is
fine on a laptop and not fine on a reachable port. Put it behind auth and a rate
limit, and narrow CORS to the app's origin, before deploying it anywhere.

One design note worth preserving if you touch `app.py`: **the handlers are sync
`def` on purpose.** `agent.answer()` blocks for seconds, and FastAPI runs a sync
handler in a worker thread, so concurrent requests proceed. Wrapping blocking
calls in `async def` would freeze the event loop for the whole process on every
question and serialise all users behind one model call — the easiest way to make
a service like this appear to hang under light load.
