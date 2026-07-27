"""Resolving *when* a question is about, and reading a schedule at that moment.

Two jobs, both easy to get subtly wrong:

1. **Turn a `when` argument into a concrete moment**, in the right city's clock.
2. **Read a resolved weekly grid** at that moment: open or not, until when, and
   if not, when next.

Deliberately NOT here: natural-language date parsing. The model does that. It
sees the user's words ("mañana por la tarde", "this Saturday morning") along with
the current local time, and calls a tool with `when="tomorrow 15:00"`. So this
module only understands a small, fixed, English vocabulary — an internal wire
format, not user input. That is why there is no multilingual date parser in this
codebase: the layer that's genuinely good at language does that work.

What we do NOT delegate to the model is arithmetic. It's unreliable at "what
date is next Saturday", so relative words stay resolvable here and the resolved
moment gets stated back in the prompt.

Two conventions inherited from the app's data, both bug-prone:

    weekday index   0 = Sunday .. 6 = Saturday
                    (Python's datetime.weekday() is 0 = MONDAY — hence dow())
    times           minutes from midnight, local to the court's city
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import data

# Indexed the way the data is: 0 = Sunday.
DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

_DAYS = {name.lower(): i for i, name in enumerate(DAY_NAMES)}
_DAYS.update({name.lower()[:3]: i for i, name in enumerate(DAY_NAMES)})
_DAYS.update({"tues": 2, "thur": 4, "thurs": 4})

# Vague times a model is likely to pass through verbatim. Pinning them to a
# convention beats rejecting them: "is anything open tonight" should get an
# answer, and the resolved moment is always stated back to the user.
_NAMED_TIMES = {
    "morning": 10 * 60,
    "midday": 12 * 60,
    "noon": 12 * 60,
    "lunch": 12 * 60,
    "afternoon": 15 * 60,
    "evening": 19 * 60,
    "tonight": 19 * 60,
    "night": 19 * 60,
}

_TIME_RE = re.compile(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$")

# Restriction tags on a block, as the app labels them (lib/hours.js TAG_KEY).
TAG_LABELS = {
    "women": "women only",
    "wheelchair": "wheelchair",
    "55+": "55+",
    "openplay": "open play",
    "reservable": "reservable",
    "youth": "youth",
    "teen": "teen",
    True: "wheelchair",  # legacy boolean flag, pre-tags
}

# How a model (or a user quoted by one) is likely to name a tag. Maps to the id
# stored in the data. Kept small: the tool schema advertises the exact ids.
TAG_ALIASES = {
    "open play": "openplay",
    "openplay": "openplay",
    "drop in": "openplay",
    "dropin": "openplay",
    "women only": "women",
    "women": "women",
    "wheelchair": "wheelchair",
    "adaptive": "wheelchair",
    "55+": "55+",
    "senior": "55+",
    "seniors": "55+",
    "reservable": "reservable",
    "youth": "youth",
    "kids": "youth",
    "teen": "teen",
    "teens": "teen",
}

# The furthest ahead a question can sensibly ask about. Schedules are a weekly
# grid so any future date resolves, but a date beyond this is a model slip
# (a stale year, an arithmetic error) rather than a real question.
MAX_FUTURE_DAYS = 365


class WhenError(ValueError):
    """Unparseable `when`. The message is written to be handed back to the model."""


# ---------------------------------------------------------------------------
# Clock basics
# ---------------------------------------------------------------------------


def dow(moment: datetime) -> int:
    """The data's weekday index (0=Sun) for a datetime (Python's is 0=Mon)."""
    return (moment.weekday() + 1) % 7


def minutes_of(moment: datetime) -> int:
    """Minutes from midnight."""
    return moment.hour * 60 + moment.minute


def now_in(city_id: str | None) -> datetime:
    """Current time on the given city's clock (timezone-aware)."""
    return datetime.now(ZoneInfo(data.timezone(city_id)))


def fmt_minutes(mins: int) -> str:
    """Minutes from midnight as the app formats it: 540 -> '9AM', 570 -> '9:30AM'."""
    hour24, minute = divmod(int(mins), 60)
    period = "PM" if hour24 >= 12 else "AM"
    hour12 = hour24 % 12 or 12
    return f"{hour12}:{minute:02d}{period}" if minute else f"{hour12}{period}"


def fmt_block(block: list) -> str:
    """A block as '9AM–5PM' or '9AM–5PM (open play)'."""
    start, end = block[0], block[1]
    tag = TAG_LABELS.get(block[2]) if len(block) > 2 and block[2] else None
    return f"{fmt_minutes(start)}–{fmt_minutes(end)}" + (f" ({tag})" if tag else "")


# ---------------------------------------------------------------------------
# Resolving `when`
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Target:
    """The moment a question is about.

    `granularity` matters more than it looks. "Is Rossi open Saturday?" carries no
    time of day; resolving it to Saturday 00:00 and reporting "closed" would be
    technically true and completely useless. A "day" target asks retrieval to
    describe that day's hours instead of testing a single instant.
    """

    moment: datetime
    granularity: str  # "moment" | "day"
    label: str  # stated verbatim in the prompt so the model can't reinterpret it

    @property
    def dow(self) -> int:
        return dow(self.moment)

    @property
    def minutes(self) -> int:
        return minutes_of(self.moment)

    @property
    def is_day(self) -> bool:
        return self.granularity == "day"


def _parse_clock(token: str) -> int | None:
    """'10', '10:30', '10am', '7pm' -> minutes from midnight. None if not a time."""
    if token in _NAMED_TIMES:
        return _NAMED_TIMES[token]
    match = _TIME_RE.match(token)
    if not match:
        return None
    hour, minute, period = int(match.group(1)), int(match.group(2) or 0), match.group(3)
    if minute > 59:
        return None
    if period:
        if hour > 12:
            return None
        hour = hour % 12 + (12 if period == "pm" else 0)
    elif hour > 23:
        return None
    return hour * 60 + minute


def _reject_out_of_range(parsed: datetime, now: datetime, raw: str) -> None:
    """Refuse a date that can't be a real question, saying what to send instead.

    Written to be read by the model: it names the offending date, today's date,
    and the form that would have worked, so the next call is usually right.
    """
    days = (parsed.date() - now.date()).days
    if days < 0:
        raise WhenError(
            f"{raw!r} is in the past — that date was {parsed.date()}, and today is "
            f"{now.date()}. Do not build dates by hand: for an upcoming day pass the "
            "weekday name ('wednesday'), or 'today' / 'tomorrow'."
        )
    if days > MAX_FUTURE_DAYS:
        raise WhenError(
            f"{raw!r} is more than a year out ({parsed.date()}); today is {now.date()}. "
            "Schedules only cover the coming weeks — pass a weekday name like 'wednesday'."
        )


def _next_weekday(today: datetime, target_dow: int) -> datetime:
    """The next date falling on `target_dow`, counting today as valid."""
    return today + timedelta(days=(target_dow - dow(today)) % 7)


def _describe(moment: datetime, granularity: str, prefix: str = "") -> str:
    zone = moment.tzname() or ""
    # Built by hand rather than strftime('%b %-d') — the no-pad flag is
    # platform-specific and this has to behave the same on macOS and CI.
    day = f"{DAY_NAMES[dow(moment)]}, {moment.strftime('%b')} {moment.day}"
    if granularity == "day":
        # No time of day was given, so no instant is implied.
        return f"{prefix}{day} (whole day)".strip()
    clock = fmt_minutes(minutes_of(moment))
    return f"{prefix}{day} at {clock} {zone}".strip()


def resolve_when(when: str | None, city_id: str | None = None) -> Target:
    """Resolve a `when` argument against a city's clock.

    Accepted (this is the documented tool contract — see tools.py):
        None / "now"            -> right now
        "today", "tomorrow"     -> that whole day
        "saturday", "sat"       -> next such day, today counting
        "2026-07-25"            -> that whole day
        "18:00", "6pm"          -> today at that time
        "saturday 10am"         -> combined; also "tomorrow evening", "sat 14:30"
        "2026-07-25T10:00"      -> exact

    Raises WhenError with the accepted forms listed, so a tool loop can recover.
    """
    now = now_in(city_id)
    text = (when or "").strip().lower()
    if not text or text == "now":
        return Target(now, "moment", _describe(now, "moment", "right now — "))

    # ISO first: unambiguous, and the only form carrying an explicit date+time.
    iso = text.replace(" ", "T", 1) if re.match(r"^\d{4}-\d{2}-\d{2} \d", text) else text
    if re.match(r"^\d{4}-\d{2}-\d{2}", iso):
        try:
            parsed = datetime.fromisoformat(iso)
        except ValueError as exc:
            raise WhenError(f"Could not read the date {when!r}. Use YYYY-MM-DD or YYYY-MM-DDTHH:MM.") from exc
        parsed = parsed.replace(tzinfo=ZoneInfo(data.timezone(city_id)))
        # An explicit date is the only form that can land in the wrong year, and
        # a model reaching for one gets the arithmetic wrong often enough to
        # matter: an observed run answered "is there lap swim Wednesday at 4pm"
        # against 2023-07-27 — a Thursday, three years gone — and resolved it
        # silently. Anything already past is a mistake, never a question.
        _reject_out_of_range(parsed, now, when)
        granularity = "moment" if ("t" in iso or ":" in iso) else "day"
        return Target(parsed, granularity, _describe(parsed, granularity))

    # Otherwise: a day word and/or a clock time, in either order.
    base_date: datetime | None = None
    clock: int | None = None
    for token in re.split(r"[\s,]+|\bat\b", text):
        token = token.strip()
        if not token or token == "at":
            continue
        if token == "today":
            base_date = now
        elif token == "tomorrow":
            base_date = now + timedelta(days=1)
        elif token in _DAYS:
            base_date = _next_weekday(now, _DAYS[token])
        else:
            parsed_clock = _parse_clock(token)
            if parsed_clock is None:
                raise WhenError(
                    f"Could not read {when!r}. Use 'now', 'today', 'tomorrow', a weekday "
                    "('saturday'), a time ('18:00'), a combination ('saturday 10am'), "
                    "or an ISO date ('2026-07-25T10:00')."
                )
            clock = parsed_clock

    if base_date is None and clock is None:  # pragma: no cover - loop always sets one
        raise WhenError(f"Could not read {when!r}.")

    if clock is None:
        # A day with no time: describe the day, don't test an instant.
        day_start = base_date.replace(hour=0, minute=0, second=0, microsecond=0)
        return Target(day_start, "day", _describe(day_start, "day"))

    day = base_date or now
    moment = day.replace(hour=clock // 60, minute=clock % 60, second=0, microsecond=0)
    return Target(moment, "moment", _describe(moment, "moment"))


# ---------------------------------------------------------------------------
# Reading a resolved week
# ---------------------------------------------------------------------------
# `week` is what the exporter produced: 7 lists (0=Sun) of [start, end, tag?].
# All the hard work — which schedule source wins, subtracting open-play windows —
# already happened in the app's own lib/hours.js. Nothing below reinterprets it.


def blocks_on(week: list, day_index: int) -> list[list]:
    return list(week[day_index]) if week and day_index < len(week) else []


def active_block(week: list, target: Target) -> list | None:
    """The block containing the target moment, if any. Always None for a day target."""
    if target.is_day:
        return None
    at = target.minutes
    for block in blocks_on(week, target.dow):
        if block[0] <= at < block[1]:
            return block
    return None


def next_block(week: list, target: Target) -> tuple[int, list] | None:
    """The soonest upcoming block as (weekday_index, block), searching a full week."""
    at = target.minutes
    for later in blocks_on(week, target.dow):
        if later[0] > at:
            return target.dow, later
    for step in range(1, 8):
        day_index = (target.dow + step) % 7
        blocks = blocks_on(week, day_index)
        if blocks:
            return day_index, blocks[0]
    return None


def day_label(week: list, day_index: int) -> str:
    """A day's hours as one string: '8AM–9AM, 9AM–5PM (open play)' or 'closed'."""
    blocks = blocks_on(week, day_index)
    return ", ".join(fmt_block(b) for b in blocks) if blocks else "closed"


def block_tag(block: list) -> str | None:
    """A block's restriction id ('openplay'), or None for ordinary hours."""
    raw = block[2] if len(block) > 2 else None
    if not raw:
        return None
    return "wheelchair" if raw is True else str(raw)


def has_tag(week: list, tag: str) -> bool:
    """Does this sport carry `tag` anywhere in the week?"""
    return any(block_tag(b) == tag for day in (week or []) for b in day)


def tagged_windows(week: list, tag: str | None = None) -> list[dict]:
    """Every restricted block in the week, Monday-first.

    This exists because `status_at` answers "what is true at one instant", and a
    whole class of real questions — "which courts have open play?" — is about the
    *shape* of the week instead. Asking that at 11PM on a Sunday used to come
    back "none", because no court was inside an open-play block right then.
    """
    windows = []
    for day_index in [1, 2, 3, 4, 5, 6, 0]:
        for block in blocks_on(week, day_index):
            found = block_tag(block)
            if not found or (tag is not None and found != tag):
                continue
            windows.append(
                {
                    "day": DAY_NAMES[day_index],
                    "hours": f"{fmt_minutes(block[0])}–{fmt_minutes(block[1])}",
                    "restriction": TAG_LABELS.get(found, found),
                }
            )
    return windows


def week_rows(week: list) -> list[dict]:
    """The full week, Monday-first to match the app's court card."""
    return [
        {"day": DAY_NAMES[d], "hours": day_label(week, d)}
        for d in [1, 2, 3, 4, 5, 6, 0]
    ]


def status_at(week: list, target: Target) -> dict:
    """Whether a sport's drop-in is available at the target, and the nearby facts.

    Mirrors lib/hours.js getDropinStatus, with one addition: a "day" target
    reports the day's blocks rather than testing an instant.

    Keys are chosen to be read by a model as much as by code — `summary` is a
    ready-made phrase, and `open` is unambiguous.
    """
    if target.is_day:
        blocks = blocks_on(week, target.dow)
        day = DAY_NAMES[target.dow]
        return {
            "open": bool(blocks),
            "asked_about": target.label,
            "hours_that_day": day_label(week, target.dow),
            "summary": (
                f"Open for drop-in {day}: {day_label(week, target.dow)}"
                if blocks
                else f"No drop-in hours {day}."
            ),
        }

    result: dict = {"asked_about": target.label}
    current = active_block(week, target)
    if current:
        tag = TAG_LABELS.get(current[2]) if len(current) > 2 and current[2] else None
        result.update(
            open=True,
            until=fmt_minutes(current[1]),
            minutes_left=current[1] - target.minutes,
            restriction=tag,
            summary=f"Open until {fmt_minutes(current[1])}" + (f" ({tag})" if tag else ""),
        )
        return result

    result["open"] = False
    upcoming = next_block(week, target)
    if not upcoming:
        result["summary"] = "No drop-in hours listed."
        return result

    day_index, block = upcoming
    when = "later that day" if day_index == target.dow else DAY_NAMES[day_index]
    result.update(
        next_open={"day": DAY_NAMES[day_index], "at": fmt_minutes(block[0])},
        summary=f"Closed then. Next open {when} at {fmt_minutes(block[0])}.",
    )
    return result
