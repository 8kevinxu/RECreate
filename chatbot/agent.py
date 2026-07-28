"""The loop: ask the model, run what it asks for, ask again, until it answers.

    question ─▶ model ─▶ wants tools? ─yes─▶ run them ─▶ append results ─┐
                  ▲                                                       │
                  └───────────────────────────────────────────────────────┘
                            │
                            └─no─▶ that text is the answer

Everything factual already happened by the time this file runs — retrieval.py
decided what is true, tools.py decided what the model may ask for, llm.py decided
how to talk to it. What is left is orchestration and the failure modes that only
appear once a real model is in the loop:

* **A model that never stops calling tools.** Capped by `config.MAX_STEPS`, after
  which it gets one final turn with no tools at all, so it must produce prose.
* **A model that calls the same thing forever.** The identical call repeated is
  detected and answered with a nudge rather than re-run.
* **A tool that rejects the call.** Handed back as an error *result*, not raised.
  The model reads "no cricket courts; available sports are…" and retries — the
  reason retrieval's error messages are written for a reader.
* **A model that says nothing at all.** Falls through to a plain apology instead
  of returning an empty bubble.

Two arguments never come from the model. The user's **coordinates** and their
**active city** are facts the app knows and the model would otherwise invent — a
model asked for a latitude produces a plausible one, and a model guessing "sf"
for a user in Queens is worse than useless. Both are injected here.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any

import config
import data
import llm
import retrieval
import timeutil as tu
import tools

# ---------------------------------------------------------------------------
# The system prompt
# ---------------------------------------------------------------------------
# This string must be BYTE-IDENTICAL on every request. It is the cached prefix
# (see AnthropicProvider.chat), and it sits ahead of ~8KB of tool schemas that
# get cached with it. Interpolating the time, the city, or the user's name here
# would silently disable caching forever and re-bill the whole prefix every turn.
# Per-question context goes into the user's turn instead — see _with_context().

APP_FACTS = """\
About RECreate (answer app questions from this, and only this):
- RECreate finds places to play sports, plus rec-center classes. It covers San
  Francisco and New York City.
- The home screen is a map. A floating sport button switches which sport you're
  looking at; markers show the full sport icon when open for drop-in now and a
  small faded dot when closed. Tapping a marker opens that place's card with its
  weekly hours, facilities and directions.
- Swimming pools are a sport on the map, not a separate tab. Pool data is San
  Francisco only.
- Tabs along the bottom: the map, Classes, Social, and Profile.
- Starring a place saves it to Favorites for the sport you were viewing. The
  sport button has a Favorites view showing just those.
- Classes come from the city's own registration system; each class links out to
  register. Some free walk-in drop-ins can't be booked online — you just show up.
- The Social tab is for playing with other people: plan a session at a specific
  court and time, or post "I'm down to play" and let friends suggest where and
  when. Both need an account.
- Everything else — browsing the map, checking hours, saving favorites — works
  signed out.
- The app is available in English, Chinese and Spanish.
- Hours and class availability are refreshed automatically, but posted schedules
  change; the card links to the official source when there is one."""

SYSTEM_PROMPT = f"""\
You are the assistant inside RECreate, an app for finding places to play sports.
You help people find courts, fields, pools, gyms and classes, and answer
questions about how the app works.

HOW YOU KNOW THINGS
Every fact about a specific place, time, price or class comes from a tool. You
have no independent knowledge of any court, pool or class, and you must not
supply one from memory or inference.
- Call a tool before answering any question about what exists, what is open,
  what something costs, or when something happens.
- State only what a tool returned. Never add a detail nobody gave you — not a
  street, a phone number, a price, a court count, or a time.
- If a tool returns nothing, say so plainly and suggest what might work instead.
  "I don't see any open right now" is a good answer. An invented court is not.
- If a tool reports something is unavailable in the user's city, say that.
  Never substitute another city's data.

READING TOOL RESULTS
- Results carry an `asked_about` field naming the exact moment that was judged.
  Trust it over your own sense of the date, and phrase times relative to it.
- `matched` is the true number of results; `shown` is how many you were given.
  When matched is larger, say there are more rather than implying that's all.
- If `matched` is 1 or more, the answer to "is there any…" is yes — lead with
  that. Never open by denying something the tool just handed you and then name it
  anyway; one result is still a result, and a single good option is what the
  person asked for. Only say there are none when the list really is empty.
- A `status` string is already written for a reader ("Open until 8PM") — use it.
- Hours are given to you already formatted: "8AM–9AM, 9AM–5PM (open play),
  5PM–8PM". Reproduce them whole — every block, in order, exactly as written.
  Do not summarise them, do not merge them, and do not stop partway. Silently
  dropping the last block of the day is the most common way to send someone to a
  court that just closed.
- A `restriction` means that window isn't general play: women only, open play,
  55+, youth. Always pass restrictions on, and use the words you were given —
  "open play" is not "walk-up play", "women only" is not "women's hours".
  Renaming a restriction changes who is allowed to show up.
- `miles_from_user` is how far the place is from the user, nothing else.
- `miles_from_place` is distance from a place the USER named, not from them. A
  result carrying `measured_from` is already nearest-first from there, so the
  first row IS the closest — say so, and say what it was measured from.
- Never work out a most/biggest/latest/total by comparing find_courts rows; that
  list is capped and the true answer is often outside it. Use summarize_courts,
  which reads every record. Several names in `places_with_the_most` is a tie.
- Two booking numbers; confusing them sends someone to a full court.
  `percent_booked_at_asked_time` is that exact hour — use it for "how busy" and
  "without waiting". `percent_booked_overall` averages days and answers neither.
  Both are snapshots: say roughly how booked, never promise a free court.
- `special_hours` lists open-play and other restricted windows for the whole
  week, whether or not one is running at the time you asked about.
- What you weren't given is UNKNOWN, never "no" — absence of a key is not
  evidence of absence. Say you don't know.
- Empty list, but `if_one_filter_is_dropped` shows results without one of your
  filters? You over-constrained it. Call again without that filter.
- If a result is `ambiguous` with candidates, ask which one they meant.
- If a tool returns an error, read it — it usually names the valid values — then
  either call again correctly or tell the user what you'd need.

HOW YOU WRITE
- Reply in the language the user wrote in. Place names and addresses stay as
  they are; don't translate them.
- This is a chat bubble on a phone. Two or three sentences. No headings, no
  tables, and no "Label: value" lines — an address and a distance belong inside a
  sentence, not in a list. Use bullets only when naming three or more places, and
  then one short line each.
- Lead with the answer itself — the direct yes or no, or the place's name — and
  put the supporting detail after it. Do not open with a stock word like "Yes"
  when the answer isn't yes; a question about price or hours has no yes in it.
- Include what someone acting on this needs: the name, when, and roughly where
  or how far. Skip ids and internal field names.
- Don't narrate your process. No "let me check" or "based on the tool results".

STAYING WITHIN THE QUESTION
Pass only the filters the user actually asked for. If they didn't name a day,
don't search one day; if they didn't say "today", don't restrict to today; if
they didn't ask for free or for openings, don't filter on those. Narrowing a
search they didn't ask you to narrow turns a real answer into "nothing found".

{APP_FACTS}"""


# ---------------------------------------------------------------------------
# Result shape
# ---------------------------------------------------------------------------


@dataclass
class Step:
    """One tool call and what came of it — the audit trail for an answer."""

    tool: str
    arguments: dict
    ok: bool
    ms: int
    result_chars: int = 0
    error: str | None = None
    result: Any = None  # kept only when debugging


@dataclass
class Answer:
    # Defaults so the loop can build this up front and fill the reply in at
    # whichever exit it takes.
    reply: str = ""
    steps: list[Step] = field(default_factory=list)
    provider: str = ""
    model: str = ""
    usage: dict = field(default_factory=dict)
    stopped_because: str = "answered"

    def to_dict(self, debug: bool = False) -> dict:
        payload: dict[str, Any] = {
            "reply": self.reply,
            "provider": self.provider,
            "model": self.model,
            "tools_used": [s.tool for s in self.steps],
            "stopped_because": self.stopped_because,
        }
        if debug:
            payload["usage"] = self.usage
            payload["steps"] = [
                {
                    "tool": s.tool,
                    "arguments": s.arguments,
                    "ok": s.ok,
                    "ms": s.ms,
                    "result_chars": s.result_chars,
                    **({"error": s.error} if s.error else {}),
                    **({"result": s.result} if s.result is not None else {}),
                }
                for s in self.steps
            ]
        return payload


# ---------------------------------------------------------------------------
# Per-question context
# ---------------------------------------------------------------------------


def _screen_phrase(state: dict) -> str:
    """What the user is looking at, as a sentence the model can resolve "it" against.

    The assistant used to be a tab you navigated to, so a question always arrived
    with no idea what was on screen. Reached from a floating button it usually
    does: someone tapping it while a court card is open and asking "is it open
    tomorrow?" means *that* court, and without this they get asked which one.

    Only the screen and the open record are passed. Never a fact about the court
    — the name is a pointer for the model to call get_court with, not a source of
    hours or facilities, which still have to come from a tool.
    """
    court = (state.get("court_name") or "").strip()
    court_id = (state.get("court_id") or "").strip()
    sport = (state.get("sport") or "").strip()
    screen = (state.get("screen") or "").strip()

    if court and court_id:
        line = f'They have {court!r} open (court id {court_id!r})'
        if sport:
            line += f", showing its {sport} information"
        return (
            line + ". Treat a bare 'it', 'this' or 'here' as that place, and pass "
            "that court id to tools rather than searching by name. Look up anything "
            "you state about it — being on screen is not knowing its hours."
        )
    if screen == "classes":
        return "They are browsing the Classes list, so a bare 'these' means classes."
    if screen == "map" and sport:
        return f"They are on the map with {sport} selected, so a bare 'these' or 'any' means {sport}."
    return ""


def _with_context(messages: list[dict], city_id: str, now, state: dict | None = None) -> list[dict]:
    """Append the volatile facts to the last user turn.

    Deliberately NOT in the system prompt: the current time changes every
    request, and anything in the system prompt is part of the cached prefix.
    A timestamp up there would invalidate the cache on every single question.
    The same applies to what's on screen, which changes even faster.

    The model needs the date only for phrasing ("tonight", "this weekend") — not
    for arithmetic. `when="saturday"` is resolved in Python against the city's
    clock, so the model never has to work out what date Saturday is.
    """
    out = [dict(m) for m in messages]
    screen = _screen_phrase(state or {})
    context = (
        f"(Context — the user is in {data.city_name(city_id)}. "
        f"Local time is {tu.DAY_NAMES[tu.dow(now)]}, "
        f"{now.strftime('%b')} {now.day}, {tu.fmt_minutes(tu.minutes_of(now))}. "
        f"Tools default to this city; you don't need to pass it."
        + (f" {screen}" if screen else "")
        + ")"
    )
    for message in reversed(out):
        if message["role"] == "user":
            message["content"] = f"{message['content']}\n\n{context}"
            return out
    out.append({"role": "user", "content": context})
    return out


def _inject_state(name: str, arguments: dict, city_id: str) -> dict:
    """Fill in the arguments that belong to the app, not the model.

    `city` is defaulted rather than overridden — a user in New York asking "what
    about San Francisco?" should still get San Francisco. But a model that simply
    omitted it must not fall through to retrieval's global default, which would
    quietly answer about the wrong city.
    """
    merged = dict(arguments)
    accepts_city = "city" in tools.SCHEMAS.get(name, {}).get("properties", {})
    if accepts_city and not merged.get("city"):
        merged["city"] = city_id
    return merged


# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------

# A result over this many characters gets truncated before the model reads it.
# Nothing retrieval returns should come close (its own tests cap payloads well
# below), so tripping this means a bug upstream — better a truncated result with
# a visible marker than a blown context window.
MAX_RESULT_CHARS = 20_000


def _run_tool(call: llm.ToolCall, city_id: str, origin, keep_result: bool) -> tuple[Step, dict]:
    """Execute one tool call. Returns (step, neutral tool message).

    Never raises. A rejected call becomes an error *result* the model can read
    and recover from — that recovery path is why retrieval's error messages name
    the valid values.
    """
    started = time.monotonic()
    arguments = _inject_state(call.name, call.arguments, city_id)
    # Record what will ACTUALLY run, not what the model asked for. A model that
    # invents `lat`/`lng` has them dropped as unadvertised arguments — but a trace
    # showing them would suggest the tool received coordinates when it did not,
    # which is exactly the wrong thing to believe while debugging a wrong answer.
    try:
        arguments = tools.prepare_args(call.name, arguments)
    except retrieval.ToolError:
        pass  # unknown tool; the call below reports it properly

    try:
        result = tools.call(call.name, arguments, origin=origin)
        body = json.dumps(result, ensure_ascii=False)
        truncated = len(body) > MAX_RESULT_CHARS
        if truncated:
            body = body[:MAX_RESULT_CHARS] + '… (truncated)"'
        step = Step(
            tool=call.name,
            arguments=arguments,
            ok=True,
            ms=int((time.monotonic() - started) * 1000),
            result_chars=len(body),
            result=result if keep_result else None,
        )
        return step, {
            "role": "tool",
            "tool_call_id": call.id,
            "name": call.name,
            "content": body,
        }

    except retrieval.ToolError as exc:
        # Expected: a bad argument. The message names the valid values.
        message = str(exc)
    except Exception as exc:  # noqa: BLE001 - a bug here must not kill the turn
        # Unexpected: a defect in retrieval. Recorded in the trace so it's
        # findable, while the conversation degrades to an apology.
        message = f"The lookup failed unexpectedly ({type(exc).__name__}). Tell the user you couldn't check."

    step = Step(
        tool=call.name,
        arguments=arguments,
        ok=False,
        ms=int((time.monotonic() - started) * 1000),
        error=message,
    )
    return step, {
        "role": "tool",
        "tool_call_id": call.id,
        "name": call.name,
        "content": message,
        "is_error": True,
    }


def answer(
    messages: list[dict],
    state: dict | None = None,
    *,
    debug: bool = False,
    provider: llm.Provider | None = None,
) -> Answer:
    """Answer the latest user message, running tools as the model asks for them.

    `messages` is the conversation so far, `[{"role": "user"|"assistant",
    "content": str}, ...]`. `state` is what the app knows: `{"city": "sf",
    "lat": …, "lng": …}`.
    """
    state = state or {}
    engine = provider or llm.get_provider()
    payload = llm.tool_payload(engine)

    city_id = (state.get("city") or data.DEFAULT_CITY).lower()
    if not data.city(city_id):
        city_id = data.DEFAULT_CITY
    origin = None
    if state.get("lat") is not None and state.get("lng") is not None:
        origin = (float(state["lat"]), float(state["lng"]))

    now = tu.now_in(city_id)
    working = _with_context(messages, city_id, now, state)

    result = Answer(provider=engine.name, model=engine.model)
    usage_total: dict[str, int] = {}
    seen_calls: set[str] = set()

    for step_number in range(config.MAX_STEPS):
        reply = engine.chat(SYSTEM_PROMPT, working, payload)
        _accumulate(usage_total, reply.usage)

        if not reply.wants_tools:
            if _looks_like_a_leaked_tool_call(reply.text):
                # Don't hand the user raw JSON. Reflect it back and let the model
                # try again — it usually calls the tool properly the second time.
                result.steps.append(
                    Step(tool="(leaked tool call)", arguments={}, ok=False, ms=0,
                         error=reply.text[:200])
                )
                working.append({"role": "user", "content":
                    "That came through as text, not a tool call, so nothing ran. "
                    "Use the tool properly, or answer in plain words."})
                continue
            safe, scrubbed = _safe_reply(reply.text)
            result.reply = safe or _EMPTY_REPLY
            result.usage = usage_total
            result.stopped_because = (
                "leaked_tool_call" if scrubbed else "answered" if reply.text else "empty_reply"
            )
            return result

        working.append(
            {"role": "assistant", "content": reply.text, "tool_calls": reply.tool_calls}
        )

        for call in reply.tool_calls:
            fingerprint = f"{call.name}:{json.dumps(call.arguments, sort_keys=True)}"
            if fingerprint in seen_calls:
                # Already answered verbatim. Re-running it would spend a step to
                # produce a result the model has in front of it.
                result.steps.append(
                    Step(tool=call.name, arguments=call.arguments, ok=False, ms=0,
                         error="duplicate call")
                )
                working.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "name": call.name,
                        "content": "You already called this with the same arguments. "
                                   "Answer the user from the result you have.",
                        "is_error": True,
                    }
                )
                continue

            seen_calls.add(fingerprint)
            step, tool_message = _run_tool(call, city_id, origin, keep_result=debug)
            result.steps.append(step)
            working.append(tool_message)

    # Step ceiling hit. One more turn with NO tools, so prose is the only option.
    # "No tools offered" still doesn't guarantee prose — a model that has decided
    # it needs a tool will write the call out by hand — so this goes through the
    # same sanitiser as every other exit.
    final = engine.chat(SYSTEM_PROMPT, working, None)
    _accumulate(usage_total, final.usage)
    safe, scrubbed = _safe_reply(final.text)
    result.reply = safe or _EMPTY_REPLY
    result.usage = usage_total
    result.stopped_because = "leaked_tool_call" if scrubbed else "step_limit"
    return result


def _safe_reply(text: str) -> tuple[str, bool]:
    """(reply to show the user, whether a leak had to be scrubbed)."""
    if not _looks_like_a_leaked_tool_call(text):
        return text, False
    return _strip_leaked_call(text) or _LEAKED_FALLBACK, True


_EMPTY_REPLY = "Sorry — I couldn't put that together. Could you rephrase it?"

_LEAKED_FALLBACK = (
    "Sorry — I got tangled up looking that up. Could you ask it a slightly different way?"
)


# A tool call written as prose, anywhere in the reply. The leading `.*?` matters:
# the first version of this anchored at the start of the string, and every leak
# observed in practice had a preamble — "To find pickleball courts, we'll use the
# `find_courts` function with the following arguments: {…}" — so the guard passed
# it straight through to the user as an answer.
_LEAKED_CALL_RE = re.compile(
    r'\{[^{}]*"name"\s*:\s*"(\w+)"[^{}]*"(?:parameters|arguments)"\s*:\s*\{',
    re.DOTALL,
)


def _looks_like_a_leaked_tool_call(text: str) -> bool:
    """Is this 'answer' actually a tool call the model wrote as prose?

    Small models sometimes emit `{"name": "find_classes", "parameters": {…}}` as
    their visible reply instead of a structured tool call. The turn "succeeds",
    the call never runs, and the user is shown raw JSON. No prompt rule prevents
    it — the model believes it is calling the tool — so it's detected here and
    the turn is retried with the mistake pointed out.
    """
    stripped = (text or "").strip()
    if not stripped:
        return False
    if _LEAKED_CALL_RE.search(stripped):
        return True
    # Truncated or near-JSON still counts when it opens the reply: something
    # starting `{"name":` is not an answer, whatever its syntax.
    return (
        stripped.startswith("{")
        and len(stripped) <= 600
        and '"name"' in stripped
        and ('"parameters"' in stripped or '"arguments"' in stripped)
    )


def _end_of_object(text: str, start: int) -> int:
    """Index just past the `{...}` beginning at `start`, or len(text) if unclosed.

    Brace counting has to ignore braces inside strings, or an argument value like
    `{"name": "Moscone {annex}"}` would cut in the wrong place and leave a shard
    of JSON in the reply.
    """
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        char = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return i + 1
    return len(text)


def _strip_leaked_call(text: str) -> str:
    """The prose left after removing a leaked call, or '' if none of it was an answer.

    Used at the point of no return. Retrying is the better fix and is tried
    first, but when the model leaks on its final turn the user must still never
    be shown raw JSON.

    Two things get discarded rather than shown. The JSON itself, matched by
    balanced braces so no shard survives — and any remaining prose that is merely
    *announcing* the call ("To find pickleball courts we'll use the `find_courts`
    function with these arguments:"), which is not an answer either. Naming a tool
    is the tell, so remaining text that mentions one is dropped whole.
    """
    remaining = text or ""
    while (match := _LEAKED_CALL_RE.search(remaining)) is not None:
        start = match.start()
        remaining = remaining[:start] + " " + remaining[_end_of_object(remaining, start):]
    remaining = remaining.strip().rstrip(":,- \t").strip()
    if any(name in remaining for name in tools.names()):
        return ""
    return remaining if len(remaining) >= 80 else ""


def _accumulate(total: dict[str, int], usage: dict) -> None:
    """Sum token counts across the turns of one answer."""
    for key, value in (usage or {}).items():
        if isinstance(value, int):
            total[key] = total.get(key, 0) + value
