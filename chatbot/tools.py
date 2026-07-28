"""Tool schemas — how the model learns what it can ask for.

With tool-calling, these descriptions *are* the prompt engineering. The model
never sees retrieval.py; it sees this file's text and decides from it which
function to call and how to fill the arguments. A vague description here shows up
as the model picking the wrong tool, and no amount of system-prompt scolding
fixes it.

Three jobs:

1. **Describe the six retrieval functions** in neutral JSON Schema.
2. **Adapt that to each provider's wire format** — Anthropic wants
   `{name, description, input_schema}`, Ollama (OpenAI-shaped) wants
   `{type: "function", function: {name, description, parameters}}`. Same schemas,
   two envelopes, so switching providers can't change what the model can do.
3. **Sanitize what comes back.** Small models pass `"true"` where a boolean
   belongs and invent arguments that don't exist. `prepare_args` coerces and drops
   rather than letting a TypeError escape.

Two deliberate choices worth knowing:

**Enums come from the live snapshot.** The valid sports and class categories are
read out of the data at import, not typed here as literals, so the schema cannot
drift from what actually exists. They are the *union* across cities — NYC has no
pools — and retrieval rejects a per-city mismatch with a message naming that
city's real sports. One round-trip, and a schema that stays cacheable instead of
being rebuilt per request.

**`origin` is not here.** The user's coordinates reach the tools by injection from
app state (see agent.py). A model asked for a latitude will produce a plausible
one, so it is never offered the chance.
"""

from __future__ import annotations

import inspect
from typing import Any

import data
import retrieval
import timeutil

# Every sport / category that exists anywhere, read from the snapshot so this can
# never disagree with the data.
ALL_SPORTS = sorted({s for c in data.cities() for s in data.sports_in(c["id"])})
ALL_CATEGORIES = sorted({c for city in data.cities() for c in data.categories_in(city["id"])})
CITY_IDS = [c["id"] for c in data.cities()]

# Reused verbatim in several schemas: the `when` wire format. The last sentence is
# load-bearing — a model that "helpfully" adds a midnight time to a question that
# had no time in it turns "open Saturday?" into "open at 00:00?", which answers
# closed for a court open 8AM–8PM.
WHEN_DESCRIPTION = (
    "The moment to judge availability at. Omit for right now. Accepts: 'now', 'today', "
    "'tomorrow', a weekday ('saturday', 'mon'), a clock time ('18:00', '6pm'), a "
    "combination ('saturday 10am', 'tomorrow evening'), or ISO ('2026-07-25T10:00'). "
    "IMPORTANT: if the user gave no time of day, give no time of day — use "
    "when='saturday', never 'saturday 00:00'. A day alone reports that day's hours; "
    "a day plus a time tests that exact moment."
)

CITY_DESCRIPTION = (
    "City id to search. Defaults to the city the user is currently in, so only pass "
    "this when they ask about a different one."
)


# ---------------------------------------------------------------------------
# The schemas
# ---------------------------------------------------------------------------
# Plain JSON Schema, provider-neutral. Keys mirror the Python parameter names
# exactly — test_tools.py checks every one against the real signature, so a
# renamed parameter cannot silently keep being advertised.

SCHEMAS: dict[str, dict] = {
    "find_courts": {
        "description": (
            "Find places to play a sport, with each one's open/closed status at the asked-about "
            "time. This is the main tool for courts, fields, pools-as-swimming and the weight "
            "room. Use it for 'where can I play basketball', 'anything open right now near me', "
            "'outdoor tennis courts in the Mission'. "
            "Results are nearest-first when the user's location is known. "
            "Use get_court instead when the user asks about one specific place they named."
        ),
        "properties": {
            "sport": {
                "type": "string",
                "enum": ALL_SPORTS,
                "description": "Sport to look for. 'weightroom' is the gym; 'swimming' is public pools.",
            },
            "city": {"type": "string", "enum": CITY_IDS, "description": CITY_DESCRIPTION},
            "when": {"type": "string", "description": WHEN_DESCRIPTION},
            "indoor": {
                "type": "boolean",
                "description": "True for indoor only, false for outdoor only. Omit if the user didn't say.",
            },
            "open_only": {
                "type": "boolean",
                "description": (
                    "True to return only what is actually open at that time — use it when the user "
                    "says 'open', 'right now', or 'today'. Leave false for 'where can I play X', so "
                    "the answer lists options labelled open or closed instead of possibly nothing."
                ),
            },
            "name": {
                "type": "string",
                "description": (
                    "Filter by the place's own name, e.g. 'Rossi' or 'Mission Recreation Center'. "
                    "Results then come back by name relevance rather than distance. "
                    "Use `near` instead for 'closest to X', and `neighborhood` for 'in X'."
                ),
            },
            "near": {
                "type": "string",
                "description": (
                    "Sort by distance from THIS place instead of from the user — for 'closest to "
                    "Golden Gate Park', 'nearest the Ferry Building'. Takes a park, facility, "
                    "neighborhood or landmark. Adds `miles_from_place`, nearest first. Omit for "
                    "'near me': the user's own location is applied automatically."
                ),
            },
            "neighborhood": {
                "type": "string",
                "description": (
                    "Keep only places in this neighborhood, e.g. 'Mission', 'Outer Richmond'. "
                    "Matches the recorded neighborhood, unlike `name` which matches the place's name."
                ),
            },
            "exclude_neighborhood": {
                "type": "string",
                "description": (
                    "Drop places in this neighborhood — for 'anywhere but the Mission', "
                    "'not downtown'. Use with or without `neighborhood`."
                ),
            },
            "restriction": {
                "type": "string",
                "enum": sorted(set(timeutil.TAG_ALIASES.values())),
                "description": (
                    "Keep only courts whose weekly schedule contains this kind of block. "
                    "Use 'openplay' for 'which courts have open play / drop-in sessions' — "
                    "that is a property of the week, so it works whatever time you ask about."
                ),
            },
            "amenity": {
                "type": "string",
                "enum": sorted(retrieval.AMENITIES),
                "description": (
                    "Keep only courts that have this facility — use it for 'which tennis "
                    "courts have a hitting wall', 'anywhere with lights', 'full-court "
                    "basketball'. 'wall' is a hitting wall or backboard; 'full'/'half' are "
                    "court size; 'accessible' is step-free access. Not every attribute is "
                    "recorded in every city, and the result says so rather than implying none "
                    "qualify — when it does, tell the user it isn't known."
                ),
            },
            "limit": {
                "type": "integer",
                "description": f"How many to return (default {retrieval.DEFAULT_LIMIT}, max {retrieval.MAX_LIMIT}). Raise it when the user asks for 'all' or 'every'.",
            },
        },
        "required": ["sport"],
    },
    "summarize_courts": {
        "description": (
            "Whole-city figures for one sport, over EVERY record instead of a capped list: how "
            "many places, how many open, which closes latest and opens earliest that day, which "
            "has the most courts, and which also offer a second sport. "
            "Use it for any 'most / biggest / latest / earliest / how many in total' question, "
            "and for 'which place has both X and Y' — find_courts returns at most 25 rows, so a "
            "superlative read off those rows is wrong whenever the answer sits outside them. "
            "find_courts for places to go; this for a number, an extreme or an overlap."
        ),
        "properties": {
            "sport": {"type": "string", "enum": ALL_SPORTS, "description": "Sport to summarize."},
            "city": {"type": "string", "enum": CITY_IDS, "description": CITY_DESCRIPTION},
            "when": {"type": "string", "description": WHEN_DESCRIPTION},
            "also_offers": {
                "type": "string",
                "enum": ALL_SPORTS,
                "description": (
                    "Also report which of these places offer this second sport — the reliable way "
                    "to answer 'which rec center has both a weight room and basketball'."
                ),
            },
            "indoor": {
                "type": "boolean",
                "description": "True for indoor only, false for outdoor only. Omit if the user didn't say.",
            },
            "neighborhood": {
                "type": "string",
                "description": "Restrict the figures to one neighborhood.",
            },
        },
        "required": ["sport"],
    },
    "get_court": {
        "description": (
            "Full detail for ONE court the user named: the complete weekly drop-in schedule, "
            "address, phone, number of courts, lights/restrooms, and how booked it is. "
            "Use this for 'when is X open', 'what are the hours at X', 'how many courts does X have'. "
            "Always pass `sport` when you know it — a park hosting four sports otherwise returns "
            "four schedules and dilutes the one that was asked about. "
            "If the name is ambiguous this returns candidates instead of guessing; ask the user "
            "which one, or call again with an exact id."
        ),
        "properties": {
            "court": {
                "type": "string",
                "description": "Court id (e.g. 'mission-recreation-center') or name (e.g. 'Rossi').",
            },
            "sport": {"type": "string", "enum": ALL_SPORTS, "description": "Which sport's schedule is wanted."},
            "city": {"type": "string", "enum": CITY_IDS, "description": CITY_DESCRIPTION},
            "when": {"type": "string", "description": WHEN_DESCRIPTION},
        },
        "required": ["court"],
    },
    "get_reservation_policy": {
        "description": (
            "The posted booking rules and reservation links for a court — how far ahead you can "
            "reserve, slot lengths, per-person limits. Only call this when the user asks about "
            "reserving, booking or permits; it returns a long policy document. For plain opening "
            "hours use get_court."
        ),
        "properties": {
            "court": {"type": "string", "description": "Court id or name."},
            "city": {"type": "string", "enum": CITY_IDS, "description": CITY_DESCRIPTION},
        },
        "required": ["court"],
    },
    "find_classes": {
        "description": (
            "Search rec-center classes and programs — lessons, fitness, dance, arts, camps, "
            "senior programs. Returns schedule, cost, ages, remaining spots and a registration "
            "link. Use it for 'are there swim lessons', 'free yoga classes', 'anything for a "
            "7-year-old'. Not for drop-in court hours — that's find_courts."
        ),
        "properties": {
            "query": {"type": "string", "description": "Free text matched against class names, e.g. 'yoga', 'swim lessons'."},
            "category": {
                "type": "string",
                "enum": ALL_CATEGORIES,
                "description": "Restrict to one category. Call list_options to see which a city has.",
            },
            "city": {"type": "string", "enum": CITY_IDS, "description": CITY_DESCRIPTION},
            "day": {
                "type": "string",
                "description": "Only classes meeting on this weekday, e.g. 'saturday'.",
            },
            "openings_only": {
                "type": "boolean",
                "description": "True to return only classes with spots left — use it whenever the user wants to sign up.",
            },
            "free_only": {"type": "boolean", "description": "True for free classes only."},
            "age": {
                "type": "integer",
                "description": "Age of the attendee in years; keeps only classes whose age range fits.",
            },
            "limit": {
                "type": "integer",
                "description": f"How many to return (default {retrieval.DEFAULT_LIMIT}, max {retrieval.MAX_LIMIT}).",
            },
        },
        "required": [],
    },
    "get_pool_info": {
        "description": (
            "Public swimming pool information, one topic per call. 'fees' for prices and passes, "
            "'schedule' for one pool's weekly sessions (lap, family, senior, lessons), 'closures' "
            "for holiday closures, 'general' to list the pools. "
            "Ask for the narrowest topic that answers the question — a fee question should not "
            "also pull down schedules. "
            "Pools are San Francisco only; this says so plainly for other cities."
        ),
        "properties": {
            "topic": {
                "type": "string",
                "enum": ["fees", "schedule", "closures", "general"],
                "description": "Which aspect to retrieve.",
            },
            "pool": {
                "type": "string",
                "description": "Pool name, e.g. 'Balboa' or 'North Beach'. Required for topic='schedule'.",
            },
            "city": {"type": "string", "enum": CITY_IDS, "description": CITY_DESCRIPTION},
            "when": {"type": "string", "description": WHEN_DESCRIPTION},
        },
        "required": ["topic"],
    },
    "list_options": {
        "description": (
            "What a city actually offers: which sports have courts, which class categories exist, "
            "whether it has pools or golf, how many courts and classes there are. "
            "Use it for open-ended questions like 'what can I do here' or 'what sports do you "
            "cover', and whenever another tool rejects an argument and you need the valid values."
        ),
        "properties": {
            "city": {"type": "string", "enum": CITY_IDS, "description": CITY_DESCRIPTION},
        },
        "required": [],
    },
}


def names() -> list[str]:
    return list(SCHEMAS)


def _json_schema(spec: dict) -> dict:
    return {
        "type": "object",
        "properties": spec["properties"],
        "required": spec.get("required", []),
    }


# ---------------------------------------------------------------------------
# Provider envelopes
# ---------------------------------------------------------------------------


def for_anthropic() -> list[dict]:
    """Anthropic's tool format: input_schema alongside name and description."""
    return [
        {
            "name": name,
            "description": spec["description"],
            "input_schema": _json_schema(spec),
        }
        for name, spec in SCHEMAS.items()
    ]


def for_openai() -> list[dict]:
    """OpenAI-shaped tools, which is also what Ollama's /api/chat accepts."""
    return [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": spec["description"],
                "parameters": _json_schema(spec),
            },
        }
        for name, spec in SCHEMAS.items()
    ]


# ---------------------------------------------------------------------------
# Sanitizing what the model sends back
# ---------------------------------------------------------------------------
# Models — small ones especially — send `"true"` for booleans, `"5"` for integers,
# and occasionally an argument that was never offered. None of that should reach a
# Python function as a TypeError; it should either be coerced or dropped, with the
# tool left to complain about anything genuinely wrong.

_TRUE = {"true", "yes", "1", "y", "t"}
_FALSE = {"false", "no", "0", "n", "f", "none", "null", ""}


def _coerce(value: Any, declared_type: str) -> Any:
    if value is None:
        return None
    if declared_type == "boolean":
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in _TRUE:
            return True
        if text in _FALSE:
            return False
        return None  # unintelligible: let the default stand
    if declared_type == "integer":
        if isinstance(value, bool):
            return None
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None
    if declared_type == "string":
        return value if isinstance(value, str) else str(value)
    return value


def prepare_args(name: str, raw: dict | None) -> dict:
    """Clean a model's tool arguments into kwargs the function will accept.

    Unknown keys are dropped and unusable values become absent rather than
    raising, because a tool that runs and answers narrowly beats a stack trace.
    Anything actually invalid — a nonexistent sport, an unparseable `when` — is
    still rejected by retrieval, whose errors are written for the model to read
    and retry.
    """
    if name not in SCHEMAS:
        raise retrieval.ToolError(
            f"No tool named {name!r}. Available tools: {', '.join(names())}."
        )
    properties = SCHEMAS[name]["properties"]
    cleaned: dict[str, Any] = {}
    for key, value in (raw or {}).items():
        spec = properties.get(key)
        if not spec:
            continue  # hallucinated argument
        coerced = _coerce(value, spec.get("type", "string"))
        if coerced is not None:
            cleaned[key] = coerced
    return cleaned


def call(name: str, raw_args: dict | None, *, origin: tuple[float, float] | None = None) -> dict:
    """Run a tool by name with model-supplied arguments.

    The single dispatch point: arguments are sanitized here, and `origin` is
    injected here rather than being something the model could pass.
    """
    kwargs = prepare_args(name, raw_args)
    if name in retrieval.ACCEPTS_ORIGIN and origin is not None:
        kwargs["origin"] = origin
    return retrieval.TOOLS[name](**kwargs)


def describe_for_humans() -> str:
    """One line per tool — handy in a REPL and in the service's /health output."""
    return "\n".join(
        f"{name}({', '.join(spec['properties'])})" for name, spec in SCHEMAS.items()
    )


def _assert_schemas_match_functions() -> None:
    """Fail at import if a schema and its function have drifted apart.

    Cheap insurance against the worst failure in a tool-calling system: the model
    is told about an argument the function does not take, calls it correctly by
    its own lights, and the whole turn dies on a TypeError.
    """
    for name, spec in SCHEMAS.items():
        function = retrieval.TOOLS.get(name)
        if function is None:
            raise RuntimeError(f"Schema {name!r} has no function in retrieval.TOOLS.")
        parameters = inspect.signature(function).parameters
        for prop in spec["properties"]:
            if prop not in parameters:
                raise RuntimeError(f"{name}: schema advertises {prop!r}, which the function does not accept.")
        if "origin" in spec["properties"]:
            raise RuntimeError(f"{name}: `origin` must never be advertised to the model.")
    missing = set(retrieval.TOOLS) - set(SCHEMAS)
    if missing:
        raise RuntimeError(f"Tools with no schema, unreachable by the model: {sorted(missing)}")


_assert_schemas_match_functions()
