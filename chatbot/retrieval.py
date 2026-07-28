"""The tools. This is the truth layer.

Every fact the assistant states should come from a function in this file. The
model's job is to pick a tool, fill its arguments, and phrase the result — never
to decide whether a court is open. That division is the entire reason a small
model can be trusted here: it cannot invent an opening it was never handed.

Three rules shape every function below. Each one was learned the hard way.

**Return narrow payloads.** A tool result is context the model has to read. Ship
a court's full reserved-slots table (≈3KB of per-half-hour booking data) alongside
its opening hours and the hours get lost in the noise — the documented failure mode
is a model answering "check the app for fees" with the fees in its context. So
`find_courts` returns a booked *percentage*, not the slot table, and the long
reservation policy has its own tool nobody calls unless asked.

**Say how many matched, not just what's shown.** Truncating to five results and
staying quiet about it makes the model claim there are five. Every list result
carries `matched` and `shown`.

**Never guess across cities.** Pools exist only in San Francisco. A swimming
question from Queens must come back "not available here" rather than silently
serving SF's pools.

One argument never comes from the model: `origin`. The user's coordinates are
injected by the agent from the app's request state, because a model asked for a
latitude will happily produce a plausible one.
"""

from __future__ import annotations

import math
import re
from typing import Any, Callable

import data
import timeutil as tu

DEFAULT_LIMIT = 5
MAX_LIMIT = 25


class ToolError(ValueError):
    """A bad call. The message is written to be handed back to the model verbatim,
    so it should say what was wrong AND what a valid call looks like."""


# Sports the model might name differently than the data does. This is a short
# list on purpose: the tool schema (tools.py) advertises the exact sport ids, and
# unlike a keyword router this needs no Spanish or Chinese vocabulary — the model
# translates the user's words before it ever calls a tool.
SPORT_ALIASES = {
    "ping pong": "pingpong",
    "ping-pong": "pingpong",
    "table tennis": "pingpong",
    "hoops": "basketball",
    "gym": "weightroom",
    "weights": "weightroom",
    "weight room": "weightroom",
    "lifting": "weightroom",
    "swim": "swimming",
    "swimming pool": "swimming",
    "pool": "swimming",
    "football": "soccer",
    "futbol": "soccer",
    "softball": "baseball",
    "paddle": "pickleball",
}


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _haversine_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in miles (port of lib/distance.js — 4 lines, no drift risk)."""
    radius = 3958.8
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lng / 2) ** 2
    )
    return radius * 2 * math.asin(math.sqrt(a))


def _distance_from(origin: tuple[float, float] | None, record: dict) -> float | None:
    if not origin or record.get("lat") is None or record.get("lng") is None:
        return None
    return round(_haversine_miles(origin[0], origin[1], record["lat"], record["lng"]), 1)


def _clamp_limit(limit: Any) -> int:
    try:
        value = int(limit)
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    return max(1, min(value, MAX_LIMIT))


def _resolve_city(city: str | None) -> str:
    """Validate a city id, listing the real ones when it's wrong."""
    city_id = (city or data.DEFAULT_CITY).lower()
    if not data.city(city_id):
        known = ", ".join(c["id"] for c in data.cities())
        raise ToolError(f"Unknown city {city!r}. Available cities: {known}.")
    return city_id


def _resolve_sport(sport: str | None, city_id: str) -> str:
    if not sport:
        raise ToolError(f"A sport is required. Available in {data.city_name(city_id)}: "
                        + ", ".join(data.sports_in(city_id)))
    key = data.normalize(sport)
    resolved = SPORT_ALIASES.get(key, key.replace(" ", ""))
    available = data.sports_in(city_id)
    if resolved not in available:
        raise ToolError(
            f"No {sport!r} courts in {data.city_name(city_id)}. "
            f"Available sports there: {', '.join(available)}."
        )
    return resolved


def _resolve_when(when: str | None, city_id: str) -> tu.Target:
    """Turn a `when` argument into a Target, re-raising as a ToolError."""
    try:
        return tu.resolve_when(when, city_id)
    except tu.WhenError as exc:
        raise ToolError(str(exc)) from exc


# Words that appear in so many facility names they carry no identifying power.
# A partial match on these alone is noise, not a match — see _score_name.
GENERIC_PLACE_WORDS = frozenset(
    """park playground playfield recreation rec center centre field fields court
    courts square complex area clubhouse gym gymnasium pool house yard garden
    plaza the of and at""".split()
)

# The score at which every word of the query is present in the name. Below this,
# a match is partial and should not be described to the model as a close one.
STRONG_NAME_MATCH = 500


def _score_name(query: str, record: dict) -> int:
    """How well a record's name matches free text. 0 means no match.

    Deliberately crude — an exact hit, then a name containing every word, then
    partial word overlap, then a hit on neighborhood/address. Fuzzier matching
    (edit distance, embeddings) would buy little: the model has usually already
    read the correct name off an earlier tool result.

    Partial overlap counts only DISTINCTIVE words. Scoring every shared token
    equally meant `name="Golden Gate Park"` matched Buena Vista Park, Carl Larsen
    Park and Glen Park Rec Center — on the word "park" alone — and find_courts
    then labelled that ordering "closest name match", which the model reasonably
    believed and read out as the courts nearest Golden Gate Park. A query whose
    only overlap is generic scores 0, so the caller gets an empty result it can
    recover from instead of a confident wrong one.
    """
    wanted = data.tokens(query)
    if not wanted:
        return 0
    if record["_norm"] == data.normalize(query):
        return 1000
    name_words = set(record["_norm"].split())
    if wanted <= name_words:
        return STRONG_NAME_MATCH + len(wanted)
    overlap = wanted & name_words
    distinctive = overlap - GENERIC_PLACE_WORDS
    if distinctive:
        # Generic words still break ties between equally distinctive matches, so
        # "Mission Playground" outranks "Mission Bay" for "Mission Playground".
        return 100 * len(distinctive) + len(overlap)
    where_words = set(record.get("_norm_where", "").split())
    where_distinctive = (wanted & where_words) - GENERIC_PLACE_WORDS
    return 10 * len(where_distinctive)


def _match_scored(query: str, records: list[dict]) -> list[tuple[int, dict]]:
    """(score, record) pairs for everything matching free text, best first."""
    scored = [(s, r) for r in records if (s := _score_name(query, r))]
    scored.sort(key=lambda pair: (-pair[0], pair[1]["name"]))
    return scored


# ---------------------------------------------------------------------------
# Anchors: "closest to <somewhere that isn't the user>"
# ---------------------------------------------------------------------------
# Every court carries lat/lng, so "the two closest pickleball courts to Golden
# Gate Park" is answerable — there was just no way to ask it. `name` filtered by
# name and `origin` measured from the phone, so the assistant answered with the
# courts nearest the *user* and said so, which is a different question.
#
# A place resolves to coordinates in four ways, most trustworthy first: a curated
# landmark, the centroid of facilities whose names contain every word, the
# centroid of a neighborhood, then a distinctive partial name match. Anything
# weaker raises rather than guessing — a wrong anchor silently reorders the whole
# answer, which is exactly the failure this replaces.

# Civic reference points people navigate by that have no row in the data.
# Deliberately tiny: anything that IS a park or facility resolves from the
# snapshot itself, which stays correct as the data changes. These do not.
LANDMARKS: dict[str, dict[str, tuple[float, float]]] = {
    "sf": {
        "union square": (37.7880, -122.4075),
        "ferry building": (37.7955, -122.3937),
        "embarcadero": (37.7955, -122.3937),
        "civic center": (37.7793, -122.4193),
        "financial district": (37.7946, -122.3999),
        "downtown": (37.7879, -122.4074),
        "fishermans wharf": (37.8080, -122.4177),
        "chinatown": (37.7941, -122.4078),
        "twin peaks": (37.7544, -122.4477),
        "ocean beach": (37.7594, -122.5107),
        "oracle park": (37.7786, -122.3893),
        "chase center": (37.7680, -122.3877),
    },
    "nyc": {
        "times square": (40.7580, -73.9855),
        "midtown": (40.7549, -73.9840),
        "downtown": (40.7128, -74.0060),
        "wall street": (40.7061, -74.0087),
        "grand central": (40.7527, -73.9772),
        "coney island": (40.5755, -73.9707),
        "yankee stadium": (40.8296, -73.9262),
        "jfk airport": (40.6413, -73.7781),
    },
}


_AREA_SPLIT = re.compile(r"[,/]")


def _neighborhood_parts(record: dict) -> set[str]:
    """A record's neighborhoods, normalized and split apart.

    The field joins names two ways — with a comma when a place straddles areas
    ("Golden Gate Park, Outer Richmond") and with a slash when the city treats
    them as one district ("Sunset/Parkside"). Both halves have to be reachable, or
    asking about the Sunset falls through to matching court *names*.
    """
    raw = str(record.get("neighborhood") or "")
    return {p for part in _AREA_SPLIT.split(raw) if (p := data.normalize(part))}


# How close two records have to be to count as the same site. Generous on purpose
# — Balboa Pool sits 0.18 miles from Balboa Park's centre and is unarguably in it
# — which is safe only because a shared distinctive name is required too.
CO_LOCATED_MILES = 0.25


def _same_site_pairs(courts: list[dict], others: list[dict]) -> list[dict]:
    """Records that are one place in real life but two rows in the data.

    A pool is its own record even when it sits inside the rec center it shares a
    name and an address with. So intersecting ids answers "no single place has
    both basketball and a pool" — which is how the assistant came to plan two
    trips to Hamilton, where the gym and the pool are the same building at 1900
    Geary.

    Pairing needs BOTH a shared distinctive name word and a quarter-mile radius.
    Either test alone is wrong: the name alone joins Mission Playground to Mission
    Dolores Park across the neighborhood, and distance alone joins whatever
    happens to sit on the next block. Together they find 11 pairs across San
    Francisco, all real ones — Hamilton, Garfield, Balboa, Rossi, Mission,
    Eureka Valley, Crocker Amazon, Glen Park.
    """
    by_token: dict[str, list[dict]] = {}
    for other in others:
        for token in data.tokens(other.get("name")) - GENERIC_PLACE_WORDS:
            by_token.setdefault(token, []).append(other)

    pairs: list[dict] = []
    for court in courts:
        if court.get("lat") is None:
            continue
        seen: set[str] = set()
        for token in data.tokens(court.get("name")) - GENERIC_PLACE_WORDS:
            for other in by_token.get(token, ()):
                if other["id"] == court["id"] or other["id"] in seen or other.get("lat") is None:
                    continue
                seen.add(other["id"])
                apart = _haversine_miles(court["lat"], court["lng"], other["lat"], other["lng"])
                if apart <= CO_LOCATED_MILES:
                    pairs.append(
                        {
                            "place": court["name"],
                            "and_at_the_same_site": other["name"],
                            "apart_miles": round(apart, 2),
                            "address": court.get("address") or other.get("address"),
                        }
                    )
    pairs.sort(key=lambda p: (p["apart_miles"], p["place"]))
    # The snapshot carries some sites twice ("Hamilton Recreation Center" and
    # "Hamilton Rec Center" are one building), which would otherwise name the same
    # pool in two pairs and invite the model to list one destination as two.
    nearest: dict[str, dict] = {}
    for pair in pairs:
        nearest.setdefault(pair["and_at_the_same_site"], pair)
    return list(nearest.values())


def _area_predicate(query: str, records: list[dict]) -> Callable[[dict], bool]:
    """A test for "is this place in <area>", preferring exact area names.

    Plain token-subset matching is too loose in one direction and too tight in the
    other. "Mission" is a real district, but as a subset test it also matches
    "Outer Mission" — a different part of the city, and not what someone asking
    for the Mission means. "Richmond" names no district at all; the data only has
    "Inner Richmond" and "Outer Richmond", so an exact test would find nothing.
    So: exact area name when one exists anywhere in the set, subset otherwise.
    """
    key = data.normalize(query)
    key = key[4:] if key.startswith("the ") else key
    if not key:
        return lambda c: False
    if any(key in _neighborhood_parts(record) for record in records):
        return lambda c: key in _neighborhood_parts(c)
    wanted = set(key.split())
    return lambda c: wanted <= data.tokens(c.get("neighborhood"))


def _centroid(records: list[dict]) -> tuple[float, float] | None:
    """Mean position of records that have one. None when none do."""
    located = [r for r in records if r.get("lat") is not None and r.get("lng") is not None]
    if not located:
        return None
    return (
        sum(r["lat"] for r in located) / len(located),
        sum(r["lng"] for r in located) / len(located),
    )


def _resolve_anchor(place: str, city_id: str) -> dict:
    """A named place -> coordinates to measure from, or a ToolError saying why not.

    Returns the point plus how it was found, which travels into the result so the
    model can tell the user "measured from the middle of Golden Gate Park" rather
    than implying a precision that isn't there.
    """
    key = data.normalize(place)
    # People say "the Mission", "the Sunset". The article is never part of a
    # recorded name, and leaving it on sent both to a name match instead.
    key = key[4:] if key.startswith("the ") else key
    if not key:
        raise ToolError("`near` needs a place name, e.g. near='Golden Gate Park'.")

    if (point := LANDMARKS.get(city_id, {}).get(key)):
        return {"lat": point[0], "lng": point[1], "label": place, "resolved_from": "a known landmark"}

    courts = data.courts_in(city_id)

    # A named area, tried before names. Large parks are both a neighborhood and a
    # family of facilities, and the area is the better anchor: matching by name
    # pulls in "Golden Gate Heights Park" — a different park, whose name happens
    # to contain every word of "Golden Gate Park" — and dragged the centroid a
    # mile south of where anyone means.
    exact_area = [c for c in courts if key in _neighborhood_parts(c)]
    if (point := _centroid(exact_area)):
        return {
            "lat": point[0], "lng": point[1], "label": place,
            "resolved_from": f"the middle of {place} ({len(exact_area)} places in it)",
        }

    # Every word of the query present in the name. Several rows often share a
    # name ("Golden Gate Park - Section 1/6/7"), and their centroid is a better
    # anchor for a large park than whichever one happened to sort first.
    named = [c for c in courts if _score_name(place, c) >= STRONG_NAME_MATCH]
    if (point := _centroid(named)):
        return {
            "lat": point[0], "lng": point[1], "label": place,
            "resolved_from": (
                f"the middle of {len(named)} places named like {place!r}"
                if len(named) > 1
                else named[0]["name"]
            ),
        }

    # A neighborhood, measured from the middle of what sits in it.
    wanted = data.tokens(place)
    in_area = [c for c in courts if wanted and wanted <= data.tokens(c.get("neighborhood"))]
    if (point := _centroid(in_area)):
        return {
            "lat": point[0], "lng": point[1], "label": place,
            "resolved_from": f"the middle of the {place} area ({len(in_area)} places)",
        }

    # Last resort: a distinctive partial name match, e.g. "Rossi" for Angelo J.
    # Rossi Playground. Generic-only overlap scores 0 and never reaches here.
    partial = [c for score, c in _match_scored(place, courts) if score >= 100]
    if (point := _centroid(partial[:3])):
        return {
            "lat": point[0], "lng": point[1], "label": place,
            "resolved_from": f"a partial name match on {partial[0]['name']}",
            "uncertain": True,
        }

    raise ToolError(
        f"Could not place {place!r} on the map in {data.city_name(city_id)}. `near` accepts a "
        "park, facility or neighborhood name that exists in the data (e.g. 'Golden Gate Park', "
        "'the Mission'), or a well-known landmark. If the user named somewhere else, say you "
        "can't measure from there and offer to search by neighborhood instead."
    )


def _match_by_name(query: str, records: list[dict]) -> list[dict]:
    """Records matching free text, best first."""
    return [record for _, record in _match_scored(query, records)]


def _slot_key(moment) -> str:
    """The `slots` key covering a moment: half-hour buckets, 'YYYY-MM-DD HH:MM'."""
    return f"{moment.strftime('%Y-%m-%d')} {moment.hour:02d}:{0 if moment.minute < 30 else 30:02d}"


def _booked_at(entry: dict, target: tu.Target) -> dict | None:
    """How booked this court is at the *asked-about* time, from the slot table.

    The whole reason this exists: `pct` is one number for the entire scraped
    window, and using it to answer a question about a specific hour inverts the
    answer often enough to send people to a full court. Measured against real
    data, Rossi read 74% overall while being 100% booked at Tuesday 2PM, and
    Buena Vista read 77% overall while being completely free at the same moment.
    """
    slots = entry.get("slots")
    if not isinstance(slots, dict) or not slots:
        return None
    date = target.moment.strftime("%Y-%m-%d")

    if target.is_day:
        # No time of day was asked about, so average the day rather than pick an
        # arbitrary instant — mirrors how a "day" target is handled everywhere.
        same_day = [v for k, v in slots.items() if k.startswith(date) and isinstance(v, (int, float))]
        if not same_day:
            return None
        return {"key": "percent_booked_that_day", "value": round(sum(same_day) / len(same_day))}

    value = slots.get(_slot_key(target.moment))
    if not isinstance(value, (int, float)):
        return None
    return {"key": "percent_booked_at_asked_time", "value": int(value)}


def _booked(court: dict, sport: str, target: tu.Target | None = None) -> dict | None:
    """The rec.us booking snapshot, projected to the numbers worth stating.

    The raw entry also holds a per-half-hour `slots` map (hundreds of keys) and a
    markdown policy document. The policy is omitted on purpose — see the module
    docstring; `get_reservation_policy` serves it when asked. The slot table is
    omitted too, but no longer *discarded*: `_booked_at` reads the one bucket the
    question is about and reports it as its own key.

    `percent_booked_overall` was called `percent_booked` until a model read it as
    the answer to "how booked is it at 2pm". Same lesson as `miles_from_user` —
    naming a key for what it actually measures beats a prompt rule saying so.
    """
    entry = (court.get("reserved") or {}).get(sport)
    if not isinstance(entry, dict) or entry.get("pct") is None:
        return None
    result = {
        "percent_booked_overall": entry["pct"],
        "reservable_courts": entry.get("courts"),
        "booking_url": entry.get("url"),
        "caveat": "reservation snapshot, refreshed a few times a day",
    }
    at_time = _booked_at(entry, target) if target else None
    if at_time:
        result[at_time["key"]] = at_time["value"]
    elif target:
        result["no_data_for_asked_time"] = (
            "Reservations are only published for the next few days, and that time is "
            "outside the window. percent_booked_overall is an average, NOT that time."
        )
    return result


def _court_summary(court: dict, sport: str, target: tu.Target, origin, tag: str | None = None) -> dict:
    """One court as a list entry: identity, where, and its status at the target."""
    status = tu.status_at(court["weeks"][sport], target)
    facts = (court.get("facts") or {}).get(sport) or {}
    summary = {
        "id": court["id"],
        "name": court["name"],
        "neighborhood": court.get("neighborhood"),
        "address": court.get("address"),
        "indoor": court["indoor"],
        "open": status["open"],
        "status": status["summary"],
    }
    if status.get("restriction"):
        summary["restriction"] = status["restriction"]
    if facts.get("total"):
        summary["court_count"] = facts["total"]
    # Only the attributes a court actually has, so a row stays short and an
    # absent key never reads as a documented "no".
    present = {k: facts[k] for k in _LISTED_FACTS if facts.get(k)}
    if present:
        summary["facilities"] = present
    distance = _distance_from(origin, court)
    if distance is not None:
        # Named for what it measures. `miles_away` invited models to report it as
        # distance "from the city center" — a key that answers the question
        # outperforms a system-prompt rule saying the same thing.
        summary["miles_from_user"] = distance
    # The week's restricted windows, whether or not one is active right now — so
    # "which courts have open play" is answerable from a list call instead of
    # needing get_court on every court in the city.
    # Scoped to the tag that was asked for when there is one — a court like
    # Moscone carries a dozen tagged windows, and listing all of them in every
    # row of a list result buries the ones the question is about.
    special = tu.tagged_windows(court["weeks"][sport], tag)
    if special:
        summary["special_hours"] = special[:8]
        if len(special) > 8:
            summary["special_hours_note"] = f"{len(special)} in total; call get_court for the rest."
    booked = _booked(court, sport, target)
    if booked:
        for key in ("percent_booked_at_asked_time", "percent_booked_that_day"):
            if key in booked:
                summary[key] = booked[key]
        summary["percent_booked_overall"] = booked["percent_booked_overall"]
    return summary


# ---------------------------------------------------------------------------
# Tool: find_courts
# ---------------------------------------------------------------------------


# Facility attributes worth filtering on, mapped to how the data spells them.
# These live in `facts[sport]` and used to be dropped from list results entirely
# — a court's hitting wall was in the snapshot but unreachable without calling
# get_court on all 62 tennis courts, so "which courts have a wall" came back
# "there is no hitting wall mentioned".
AMENITIES = {
    "wall": "a hitting wall / backboard",
    "lights": "lights for evening play",
    "restrooms": "restrooms",
    "water": "drinking water",
    "accessible": "step-free / wheelchair access",
    "nets": "nets provided",
    "full": "a full-size court",
    "half": "a half court",
    "walkup": "walk-up (non-reservable) courts",
    "reservable": "courts that can be reserved",
}

AMENITY_ALIASES = {
    "wall": "wall",
    "hitting wall": "wall",
    "backboard": "wall",
    "practice wall": "wall",
    "lights": "lights",
    "lighting": "lights",
    "lighted": "lights",
    "restrooms": "restrooms",
    "bathroom": "restrooms",
    "bathrooms": "restrooms",
    "toilets": "restrooms",
    "water": "water",
    "drinking water": "water",
    "water fountain": "water",
    "accessible": "accessible",
    "wheelchair": "accessible",
    "wheelchair accessible": "accessible",
    "ada": "accessible",
    "step free": "accessible",
    "nets": "nets",
    "net": "nets",
    "full": "full",
    "full court": "full",
    "full size": "full",
    "regulation": "full",
    "half": "half",
    "half court": "half",
    "walkup": "walkup",
    "walk up": "walkup",
    "drop in": "walkup",
    "reservable": "reservable",
    "bookable": "reservable",
}

# Facts worth putting in a list result. `desc`, `tsf` and `note` are prose or
# nested ratings — they belong in get_court, not in every row of a list.
_LISTED_FACTS = (
    "walkup", "reservable", "lights", "restrooms", "water", "accessible",
    "nets", "wall", "full", "half", "surface", "openPlayCourts",
)


def _resolve_amenity(amenity: str) -> str:
    key = data.normalize(amenity)
    resolved = AMENITY_ALIASES.get(key)
    if not resolved:
        raise ToolError(
            f"Unknown amenity {amenity!r}. Valid values: " + ", ".join(sorted(AMENITIES)) + "."
        )
    return resolved


def _resolve_restriction(restriction: str) -> str:
    """Map how a model names a restriction onto the tag id stored in the data."""
    key = data.normalize(restriction)
    resolved = tu.TAG_ALIASES.get(key)
    if not resolved:
        raise ToolError(
            f"Unknown restriction {restriction!r}. Valid values: "
            + ", ".join(sorted(set(tu.TAG_ALIASES.values())))
            + "."
        )
    return resolved


def find_courts(
    sport: str | None = None,
    city: str | None = None,
    when: str | None = None,
    indoor: bool | None = None,
    open_only: bool = False,
    name: str | None = None,
    near: str | None = None,
    neighborhood: str | None = None,
    exclude_neighborhood: str | None = None,
    restriction: str | None = None,
    amenity: str | None = None,
    limit: int = DEFAULT_LIMIT,
    *,
    origin: tuple[float, float] | None = None,
) -> dict:
    """Places to play a sport, judged at the asked-about moment.

    `open_only` filters to what's actually available then; leaving it False lists
    the nearest options labelled open or closed, which answers "where can I play
    tennis" better than an empty list does.

    Results are ordered open-first, then by distance when the app supplied the
    user's location, then alphabetically — a stable order so the same question
    doesn't reshuffle between turns. `near` replaces that order with pure distance
    from the named place: someone asking for the two closest courts to a park
    wants the two closest, open or not.
    """
    city_id = _resolve_city(city)
    sport_id = _resolve_sport(sport, city_id)
    target = _resolve_when(when, city_id)
    anchor = _resolve_anchor(near, city_id) if near else None

    everything = data.courts_in(city_id, sport_id)

    # A bad *value* on an optional filter degrades to "not filtered, and here's
    # why", rather than failing the whole call. A rejected call costs a step and
    # tends to end with the assistant relaying the error to the user: asked for
    # open play, a model passed amenity="openplay" and replied "'openplay' is not
    # a valid amenity, try lights, nets, reservable…". Ignoring the filter answers
    # the question approximately, and the hint usually fixes the next call.
    ignored: dict[str, str] = {}

    def optional(kind: str, value: str | None, resolve, other: str, other_ok) -> Any:
        if not value:
            return None
        try:
            return resolve(value)
        except ToolError as exc:
            hint = str(exc)
            if other_ok(value):
                hint = (
                    f"{value!r} is a `{other}` filter, not a `{kind}` one. "
                    f"It was ignored — call again passing it as `{other}`."
                )
            ignored[kind] = hint
            return None

    wanted_tag = optional(
        "restriction", restriction, _resolve_restriction, "amenity",
        lambda v: data.normalize(v) in AMENITY_ALIASES,
    )
    amenity_key = optional(
        "amenity", amenity, _resolve_amenity, "restriction",
        lambda v: data.normalize(v) in tu.TAG_ALIASES,
    )

    # Presence of the *field*, across the whole sport in this city. Tennis records
    # carry facilities but never a `nets` key, so counting courts-that-have-facts
    # would turn "we don't track nets for tennis" into a confident "none have
    # nets" — and NYC, where hitting walls aren't recorded at all, into "none".
    amenity_documented = (
        sum(1 for c in everything if amenity_key in ((c.get("facts") or {}).get(sport_id) or {}))
        if amenity_key
        else 0
    )

    # Each filter as a named predicate, so "how many would there be without just
    # this one" is a real answer instead of an artefact of the order they ran in.
    # The first version reported the running count from before each filter, which
    # equals the true figure only for whichever filter happened to be last — and
    # the model reads these numbers out to the user.
    tests: list[tuple[str, Callable[[dict], bool]]] = []
    if indoor is not None:
        tests.append(("indoor", lambda c: c["indoor"] is bool(indoor)))
    if wanted_tag:
        tests.append(("restriction", lambda c: tu.has_tag(c["weeks"][sport_id], wanted_tag)))
    if amenity_key:
        tests.append(
            ("amenity", lambda c: bool(((c.get("facts") or {}).get(sport_id) or {}).get(amenity_key)))
        )
    if name:
        scored = _match_scored(name, everything)
        rank = {c["id"]: i for i, (_, c) in enumerate(scored)}
        best_name_score = scored[0][0] if scored else 0
        tests.append(("name", lambda c: c["id"] in rank))
    if neighborhood:
        in_area = _area_predicate(neighborhood, everything)
        tests.append(("neighborhood", in_area))
    if exclude_neighborhood:
        in_excluded = _area_predicate(exclude_neighborhood, everything)
        tests.append(("exclude_neighborhood", lambda c: not in_excluded(c)))

    def surviving(skip: str | None = None) -> list[dict]:
        kept = everything
        for label, test in tests:
            if label != skip:
                kept = [c for c in kept if test(c)]
        return kept

    candidates = surviving()
    if name:
        candidates.sort(key=lambda c: rank[c["id"]])

    summaries = [_court_summary(c, sport_id, target, origin, wanted_tag) for c in candidates]
    if anchor:
        # Distance from the named place, under its own key. Reusing
        # `miles_from_user` would make "1.1 mi" mean two different things in two
        # different answers, and the system prompt promises it means one.
        for summary, court in zip(summaries, candidates):
            miles = _distance_from((anchor["lat"], anchor["lng"]), court)
            if miles is not None:
                summary["miles_from_place"] = miles
    total_matched = len(summaries)
    open_count = sum(1 for s in summaries if s["open"])
    summaries_before_open_filter = summaries
    if open_only:
        summaries = [s for s in summaries if s["open"]]

    if anchor:
        # "Closest to X" is a question about distance, so distance wins outright
        # here — an open-first sort would answer with a further court that happens
        # to be open and call it the closest.
        summaries.sort(key=lambda s: (s.get("miles_from_place", float("inf")), s["name"]))
    elif not name:
        summaries.sort(
            key=lambda s: (
                not s["open"],
                s.get("miles_from_user", float("inf")),
                s["name"],
            )
        )
    # When the user named a place, name relevance already ordered these and must
    # survive: re-sorting by open-then-distance pushed "Mission Recreation Center"
    # out of the top results behind closer courts that merely sit in the Mission.
    shown = summaries[: _clamp_limit(limit)]

    result = {
        "sport": sport_id,
        "city": data.city_name(city_id),
        "asked_about": target.label,
        "matched": total_matched if not open_only else open_count,
        "open_now_count": open_count,
        "shown": len(shown),
        "courts": shown,
    }
    applied = []
    if indoor is not None:
        applied.append("indoor only" if indoor else "outdoor only")
    if wanted_tag:
        applied.append(f"{wanted_tag} in the weekly schedule")
    if amenity_key:
        applied.append(f"has {AMENITIES[amenity_key]}")
    if applied:
        result["filtered_to"] = ", ".join(applied)
    if ignored:
        result["ignored_filters"] = ignored
    if anchor:
        result["measured_from"] = {
            "place": anchor["label"],
            "how": anchor["resolved_from"],
            "note": (
                f"`miles_from_place` is the distance from {anchor['label']}. "
                "Order is nearest-first from there, so the first row IS the closest."
            ),
        }
        if anchor.get("uncertain"):
            result["measured_from"]["warning"] = (
                f"{anchor['label']!r} was matched loosely — say roughly where you measured from."
            )
    if name:
        # Only claim a close match when every word actually landed in a name.
        # Below that the ordering is a weak signal, and describing it as "closest
        # name match" is what let a search for a park return unrelated parks.
        result["ordered_by"] = (
            f"closest name match to {name!r}"
            if best_name_score >= STRONG_NAME_MATCH
            else f"loose partial name match on {name!r} — these may not be what was meant"
        )

    if amenity_key and not amenity_documented:
        # Distinguish "none have it" from "nobody recorded it" — the second is not
        # a No, and answering it as one is how the assistant told a user there was
        # "no hitting wall mentioned" for a city where 7 courts have one.
        result["note_amenity_data"] = (
            f"Whether a {sport_id} court has {AMENITIES[amenity_key]} is not "
            f"recorded for {data.city_name(city_id)}, so the answer is UNKNOWN — say you "
            "don't know. Do NOT report this as none of them having it."
        )

    if not shown:
        result["note"] = (
            f"Nothing open for {sport_id} at that time."
            if open_only and total_matched
            else f"No {sport_id} courts in {data.city_name(city_id)} matched every filter."
        )
        # Which single filter is doing the damage, with the real count for
        # dropping exactly that one. A bare empty result gets reported to the user
        # as "there are none" — that is how an invented `indoor=false` came to
        # hide every pool in the city and produce "nothing is open".
        # Names, not just counts. A count alone tells the model something exists
        # without saying what, and asked to name one it invents: given "4 courts
        # without that filter" it answered "a court called Mission Tennis Center"
        # and "the court at 1000 Mason St", neither of which exists. Handing over
        # the real names removes the gap it was filling.
        def relaxation(label: str | None) -> dict | None:
            others = surviving(label)
            if open_only:
                others = [c for c in others if tu.status_at(c["weeks"][sport_id], target)["open"]]
            if not others:
                return None
            return {
                "count": len(others),
                "examples": [c["name"] for c in others[:5]],
            }

        relaxed = {}
        for label, _ in tests:
            if (entry := relaxation(label)) is not None:
                relaxed[f"without {label}"] = entry
        # Asking for open_only at midnight is its own trap: everything matches and
        # nothing is open, so the honest recovery is to drop the time constraint.
        if open_only and total_matched:
            relaxed["without open_only (these match but are CLOSED at that time)"] = {
                "count": total_matched,
                "examples": [s["name"] for s in summaries_before_open_filter[:5]],
            }
        if relaxed:
            result["if_one_filter_is_dropped"] = relaxed
    elif origin is None and not anchor:
        result["note"] = "User location unknown, so these are not sorted by distance."
    return result


# ---------------------------------------------------------------------------
# Tool: summarize_courts
# ---------------------------------------------------------------------------


def summarize_courts(
    sport: str | None = None,
    city: str | None = None,
    when: str | None = None,
    also_offers: str | None = None,
    indoor: bool | None = None,
    neighborhood: str | None = None,
) -> dict:
    """Whole-set figures for one sport: counts, extremes, and cross-sport overlap.

    find_courts caps at 25 rows, which is the right call for "where can I play" —
    but the model was also answering *superlatives* from those rows, and a
    superlative computed over a truncated sample is simply wrong. Three real
    failures, all from the same cause: "everything closes at 8PM" (one facility
    ran to 8:50PM, outside the 15 fetched), "Mission Dolores Park has the most
    tennis courts" (John McLaren Park ties it, outside the nearest 25), and — the
    worst, because it denied a true fact — "Mission and Glen Park rec centers have
    weight rooms but I don't see basketball listed at them", from intersecting two
    independently-truncated lists. Both do have basketball.

    So this computes over every record and returns figures, not rows. Nothing here
    is truncated, and `also_offers` does the intersection server-side.
    """
    city_id = _resolve_city(city)
    sport_id = _resolve_sport(sport, city_id)
    target = _resolve_when(when, city_id)

    courts = data.courts_in(city_id, sport_id)
    if indoor is not None:
        courts = [c for c in courts if c["indoor"] is bool(indoor)]
    if neighborhood:
        in_area = _area_predicate(neighborhood, courts)
        courts = [c for c in courts if in_area(c)]

    statuses = [(c, tu.status_at(c["weeks"][sport_id], target)) for c in courts]
    open_now = [c for c, s in statuses if s["open"]]

    result: dict[str, Any] = {
        "sport": sport_id,
        "city": data.city_name(city_id),
        "asked_about": target.label,
        "total_places": len(courts),
        "open_at_asked_time": len(open_now),
        "computed_over": "every record, not a truncated list — these figures are complete",
    }
    if indoor is not None:
        result["filtered_to"] = "indoor only" if indoor else "outdoor only"
    if neighborhood:
        result["filtered_to_area"] = neighborhood

    if not courts:
        result["note"] = f"No {sport_id} places in {data.city_name(city_id)} matched."
        return result

    # Opening and closing extremes on the target's own day, which is what "open
    # latest tonight" asks about — a facility's Friday hours don't answer it.
    day_windows: list[tuple[int, int, dict]] = [
        (block[0], block[1], court)
        for court in courts
        for block in tu.blocks_on(court["weeks"][sport_id], target.dow)
        if len(block) >= 2
    ]
    if day_windows:
        latest = max(day_windows, key=lambda w: w[1])
        earliest = min(day_windows, key=lambda w: w[0])
        result["latest_close_that_day"] = {
            "time": tu.fmt_minutes(latest[1]),
            "place": latest[2]["name"],
            "neighborhood": latest[2].get("neighborhood"),
        }
        result["earliest_open_that_day"] = {
            "time": tu.fmt_minutes(earliest[0]),
            "place": earliest[2]["name"],
            "neighborhood": earliest[2].get("neighborhood"),
        }
    else:
        result["note_that_day"] = f"Nothing has {sport_id} hours on {target.label}."

    # Court counts, with the denominator. Reporting a leader without saying how
    # many places even have a recorded count turns "the biggest of the 62 we know"
    # into "the biggest in the city".
    counted = [(((c.get("facts") or {}).get(sport_id) or {}).get("total"), c) for c in courts]
    counted = [(n, c) for n, c in counted if isinstance(n, int) and n > 0]
    if counted:
        most = max(n for n, _ in counted)
        result["court_counts"] = {
            "recorded_for": len(counted),
            "of_places": len(courts),
            "most_courts_at_one_place": most,
            # Every place tied at the top, so a tie is never reported as a winner.
            "places_with_the_most": sorted(c["name"] for n, c in counted if n == most),
            "total_courts_where_recorded": sum(n for n, _ in counted),
        }
    else:
        result["court_counts"] = {
            "recorded_for": 0,
            "of_places": len(courts),
            "note": (
                f"How many {sport_id} courts each place has is NOT recorded in "
                f"{data.city_name(city_id)}. Say the number of places, and say the "
                "per-place court count is unknown. Do not infer or add them up."
            ),
        }

    if also_offers:
        other = _resolve_sport(also_offers, city_id)
        other_courts = data.courts_in(city_id, other)
        other_ids = {c["id"] for c in other_courts}
        both = sorted(c["name"] for c in courts if c["id"] in other_ids)
        overlap: dict[str, Any] = {
            "sport": other,
            "count": len(both),
            "places": both[:25],
            "complete": len(both) <= 25,
        }
        # One record offering both sports is the clean case. The messier and more
        # common one is two records at the same site, which counts for a person
        # planning one trip and is invisible to an id intersection.
        same_site = _same_site_pairs(
            [c for c in courts if c["id"] not in other_ids],
            [c for c in other_courts if c["id"] not in {x["id"] for x in courts}],
        )
        # A pair with the same name on both sides isn't two facilities sharing a
        # site — it's one facility the snapshot stored twice, with each sport on a
        # different row. That genuinely offers both, so it belongs in the plain
        # list; left in `same_site` it reads as "X is next door to X".
        duplicated = [p for p in same_site if data.normalize(p["place"]) == data.normalize(p["and_at_the_same_site"])]
        if duplicated:
            both = sorted(set(both) | {p["place"] for p in duplicated})
            overlap.update(count=len(both), places=both[:25], complete=len(both) <= 25)
            same_site = [p for p in same_site if p not in duplicated]
        if same_site:
            overlap["same_site"] = same_site[:15]
            overlap["same_site_note"] = (
                "Separate records at the SAME place — one trip covers both. Treat each pair as "
                "one destination and say so (e.g. the pool is at the rec center). Do not tell the "
                "user these are two different places or that nowhere has both."
            )
        result["also_offers"] = overlap

    areas: dict[str, int] = {}
    for court in courts:
        areas[court.get("neighborhood") or "unknown"] = areas.get(court.get("neighborhood") or "unknown", 0) + 1
    result["by_neighborhood"] = dict(sorted(areas.items(), key=lambda kv: (-kv[1], kv[0]))[:12])
    return result


# ---------------------------------------------------------------------------
# Tool: get_court
# ---------------------------------------------------------------------------


def _find_one_court(court: str, city_id: str | None, sport: str | None) -> dict | list[dict]:
    """Resolve an id or a name to a single court, or return the candidates.

    Returning candidates rather than picking one is what makes a tool loop work:
    the model can disambiguate, or ask the user, instead of confidently
    describing the wrong playground.
    """
    exact = data.court(court)
    if exact:
        return exact
    pool = data.courts_in(city_id, sport) if sport else data.courts_in(city_id)
    matches = _match_scored(court, pool)
    if not matches:
        raise ToolError(
            f"No court named {court!r} found"
            + (f" in {data.city_name(city_id)}" if city_id else "")
            + (f" for {sport}" if sport else "")
            + ". Try find_courts to see what exists."
        )
    # One clear winner beats asking. "Mission Recreation Center" scores an exact
    # 1000 while "Mission Playground" picks up 100 for sharing a word — treating
    # that as ambiguous would make the model ask a question it already knows the
    # answer to. A genuine tie ("playground", every pool named "…Pool") does not
    # get resolved by guessing.
    best = matches[0][0]
    runner_up = matches[1][0] if len(matches) > 1 else 0
    if len(matches) == 1 or best >= 2 * runner_up:
        return matches[0][1]
    return [record for _, record in matches]


def get_court(
    court: str,
    sport: str | None = None,
    city: str | None = None,
    when: str | None = None,
    *,
    origin: tuple[float, float] | None = None,
) -> dict:
    """Everything about one court: full weekly hours, facilities, booking.

    Pass `sport` whenever it's known — a court hosting five sports otherwise
    returns five weekly schedules, and the one that was asked about gets diluted.
    """
    city_id = _resolve_city(city) if city else None
    sport_id = _resolve_sport(sport, city_id or data.DEFAULT_CITY) if sport else None
    found = _find_one_court(court, city_id, sport_id)

    if isinstance(found, list):
        return {
            "ambiguous": True,
            "note": f"{len(found)} courts match {court!r}. Ask which, or call again with an id.",
            "candidates": [
                {"id": c["id"], "name": c["name"], "neighborhood": c.get("neighborhood"),
                 "city": data.city_name(c["city"]), "sports": c["sports"]}
                for c in found[:8]
            ],
        }

    target = _resolve_when(when, found["city"])
    sports = [sport_id] if sport_id else found["sports"]

    detail: dict = {
        "id": found["id"],
        "name": found["name"],
        "city": data.city_name(found["city"]),
        "address": found.get("address"),
        "neighborhood": found.get("neighborhood"),
        "phone": found.get("phone"),
        "indoor": found["indoor"],
        "sports_here": found["sports"],
        "asked_about": target.label,
        "schedules": {},
    }
    distance = _distance_from(origin, found)
    if distance is not None:
        detail["miles_from_user"] = distance

    for one in sports:
        if one not in found["weeks"]:
            continue
        week = found["weeks"][one]
        status = tu.status_at(week, target)
        entry: dict = {
            "status": status["summary"],
            "open": status["open"],
            "weekly_hours": tu.week_rows(week),
        }
        facts = (found.get("facts") or {}).get(one)
        if facts:
            entry["facilities"] = facts
        special = tu.tagged_windows(week)
        if special:
            entry["special_hours"] = special
        booked = _booked(found, one, target)
        if booked:
            entry["reservations"] = booked
        detail["schedules"][one] = entry

    if not detail["schedules"]:
        detail["note"] = (
            f"{found['name']} has no drop-in hours listed"
            + (f" for {sport_id}" if sport_id else "")
            + f". Sports there: {', '.join(found['sports']) or 'none listed'}."
        )
    if found.get("notes"):
        detail["notes"] = found["notes"]
    if found.get("golf"):
        detail["golf"] = found["golf"]
    if found.get("pool"):
        # Pool schedules are their own shape; point at the dedicated tool rather
        # than inlining a second, differently-structured schedule here.
        detail["is_pool"] = True
        detail["pool_season"] = found["pool"].get("season")
        detail["note_pool"] = "Call get_pool_info for session types, fees and the official schedule."
    return detail


# ---------------------------------------------------------------------------
# Tool: get_reservation_policy
# ---------------------------------------------------------------------------


def get_reservation_policy(court: str, city: str | None = None) -> dict:
    """The posted booking rules for a court, when someone asks how to reserve.

    Its own tool because the policy is a page of markdown. Attached to every
    court result it would swamp the hours; requested on purpose it's exactly
    what the user wanted.
    """
    city_id = _resolve_city(city) if city else None
    found = _find_one_court(court, city_id, None)
    if isinstance(found, list):
        return {
            "ambiguous": True,
            "candidates": [{"id": c["id"], "name": c["name"]} for c in found[:8]],
        }
    reserved = found.get("reserved") or {}
    policy = reserved.get("guidelines")
    if not policy:
        return {
            "court": found["name"],
            "note": "No posted reservation policy — this location is walk-up/drop-in only.",
        }
    urls = {s: e["url"] for s, e in reserved.items() if isinstance(e, dict) and e.get("url")}
    return {
        "court": found["name"],
        "city": data.city_name(found["city"]),
        "policy": policy,
        "booking_urls": urls,
    }


# ---------------------------------------------------------------------------
# Tool: find_classes
# ---------------------------------------------------------------------------

_DAY_ABBREV = {i: name[:3] for i, name in enumerate(tu.DAY_NAMES)}


def _is_free(entry: dict) -> bool:
    cost = str(entry.get("cost") or "").strip().lower()
    return cost in ("free", "$0", "0") or cost.startswith("free")


def _has_openings(entry: dict) -> bool:
    return bool(entry.get("unlimited")) or (entry.get("spots") or 0) > 0


def _class_summary(entry: dict, origin) -> dict:
    summary = {
        "id": entry["id"],
        "name": entry["name"],
        "category": data.category_label(entry.get("category", "")),
        "location": entry.get("location"),
        "when": entry.get("when"),
        "cost": entry.get("cost"),
        "ages": entry.get("ages"),
        "dates": f"{entry.get('start')} to {entry.get('end')}" if entry.get("start") else None,
        "openings": "unlimited" if entry.get("unlimited") else entry.get("spots"),
        "drop_in": bool(entry.get("dropIn")),
        "url": entry.get("url"),
    }
    distance = _distance_from(origin, entry)
    if distance is not None:
        summary["miles_from_user"] = distance
    return {k: v for k, v in summary.items() if v is not None}


def find_classes(
    query: str | None = None,
    category: str | None = None,
    city: str | None = None,
    day: str | None = None,
    openings_only: bool = False,
    free_only: bool = False,
    age: int | None = None,
    limit: int = DEFAULT_LIMIT,
    *,
    origin: tuple[float, float] | None = None,
) -> dict:
    """Rec-center classes and programs, filtered.

    `query` matches the class name (and its location); `category` must be one of
    the ids from list_options. Age filtering uses the catalog's own min/max, so a
    class with no stated ages is never excluded for being wrong-aged.
    """
    city_id = _resolve_city(city)
    if not data.has_feature(city_id, "classes"):
        return {"unavailable": True, "note": f"No class catalog for {data.city_name(city_id)}."}

    candidates = data.classes_in(city_id)
    if category:
        wanted = data.normalize(category).replace(" ", "")
        valid = data.categories_in(city_id)
        if wanted not in valid:
            raise ToolError(f"Unknown category {category!r}. Valid: {', '.join(valid)}.")
        candidates = [c for c in candidates if c.get("category") == wanted]
    if day:
        target = _resolve_when(day, city_id)
        abbrev = _DAY_ABBREV[target.dow].lower()
        # The catalog stores its meeting pattern as display text ("Sat · 9:00 AM"),
        # so this matches on the day abbreviation rather than reparsing the string.
        candidates = [c for c in candidates if abbrev in str(c.get("when", "")).lower()]
    if openings_only:
        candidates = [c for c in candidates if _has_openings(c)]
    if free_only:
        candidates = [c for c in candidates if _is_free(c)]
    if age is not None:
        candidates = [
            c
            for c in candidates
            if (c.get("minAge") is None or age >= c["minAge"])
            and (c.get("maxAge") is None or age <= c["maxAge"])
        ]

    ordered = _match_by_name(query, candidates) if query else sorted(
        candidates, key=lambda c: (not _has_openings(c), str(c.get("start") or ""), c["name"])
    )
    shown = ordered[: _clamp_limit(limit)]

    result = {
        "city": data.city_name(city_id),
        "matched": len(ordered),
        "shown": len(shown),
        "classes": [_class_summary(c, origin) for c in shown],
    }
    applied = [
        label
        for label, on in [
            (f"category={category}", bool(category)),
            (f"day={day}", bool(day)),
            ("with openings", openings_only),
            ("free only", free_only),
            (f"age {age}", age is not None),
        ]
        if on
    ]
    if applied:
        result["filters"] = applied
    if not shown:
        # An empty result is where a model does the most damage: it reports "there
        # are none" when the truth is "none *with the filters you invented*".
        # Observed repeatedly — a model adds an unrequested day filter, gets zero
        # rows, and confidently denies a class that exists. So rather than telling
        # it to loosen a filter and hoping, the answer with each filter dropped is
        # computed here and handed over. Being right stops depending on the model
        # taking a hint.
        result["note"] = "No classes match ALL of those filters."
        relaxed = _relaxations(city_id, query, category, day, openings_only, free_only, age, origin)
        if relaxed:
            result["if_one_filter_is_dropped"] = relaxed
            result["note"] += (
                " `if_one_filter_is_dropped` shows what each filter is costing you, with examples."
                " Prefer relaxing a filter the user never asked for (a day, say) over one they did"
                " (free, an age). Offer those instead of reporting nothing."
            )
    return result


def _relaxations(city_id, query, category, day, openings_only, free_only, age, origin) -> dict:
    """For each active filter, what dropping just that one would find.

    Zero results is where a model does the most damage: it reports "there are
    none" when the truth is "none *with the filter you invented*". Observed
    repeatedly — a model adds an unrequested `day`, gets nothing, and confidently
    denies a class that exists.

    Two things were tried and were not enough. A *count* of what it would find
    still left the model leading with a denial — it needs the records themselves.
    And picking the single most productive relaxation picked wrong: for "free swim
    classes on Saturday" it dropped `free_only` (29 results) over `day` (1),
    discarding the user's actual requirement to chase a bigger number. Which
    filter the user genuinely asked for is not knowable here, so every option is
    returned and the choice is left to the layer that saw the question.

    Zero results is where a model does the most damage: it reports "there are
    none" when the truth is "none *with the filter you invented*". Observed
    repeatedly — a model adds an unrequested `day`, gets nothing, and confidently
    denies a class that exists.

    Returning a *count* of what it would find is not enough (also tested: the
    model still led with a denial). It needs the records themselves, so the right
    answer is in its context rather than one more inference away. The key name and
    note both say plainly that these did NOT match, so passing them on stays
    honest.
    """
    active = {
        "query": query,
        "category": category,
        "day": day,
        "openings_only": openings_only or None,
        "free_only": free_only or None,
        "age": age,
    }
    active = {name: value for name, value in active.items() if value is not None}
    options: dict[str, dict] = {}
    for dropped in active:
        kwargs = {k: v for k, v in active.items() if k != dropped}
        kwargs.setdefault("openings_only", False)
        kwargs.setdefault("free_only", False)
        try:
            # Two examples each: enough to name something concrete, few enough
            # that a fully-filtered miss doesn't outweigh a successful search.
            found = find_classes(city=city_id, limit=2, origin=origin, **kwargs)
        except ToolError:
            continue
        if found.get("matched"):
            options[f"without {dropped}"] = {
                "matched": found["matched"],
                "examples": found["classes"],
            }
    return options


# ---------------------------------------------------------------------------
# Tool: get_pool_info
# ---------------------------------------------------------------------------

_POOL_TOPICS = ("fees", "schedule", "closures", "general")


def get_pool_info(
    topic: str = "general",
    pool: str | None = None,
    city: str | None = None,
    when: str | None = None,
    *,
    origin: tuple[float, float] | None = None,
) -> dict:
    """Public pool facts, one topic at a time.

    Narrow by design. Answering "how much is the pool?" by returning the whole
    pool blob buried the fee table thousands of characters deep and produced
    "check the app for fees" — with the fees in context. So a fee question gets
    fees, and nothing else.
    """
    city_id = _resolve_city(city)
    if not data.has_feature(city_id, "pools"):
        return {
            "unavailable": True,
            "note": (
                f"RECreate has no pool data for {data.city_name(city_id)} — "
                "public pool schedules are San Francisco only right now."
            ),
        }
    if topic not in _POOL_TOPICS:
        raise ToolError(f"Unknown topic {topic!r}. Use one of: {', '.join(_POOL_TOPICS)}.")

    pools = data.courts_in(city_id, "swimming")

    if topic == "fees":
        fees = data.REFERENCE.get("poolFees") or {}
        # `effective` is the date these rates came INTO force. Passed through bare,
        # a model reads the date as an expiry and tells the user prices are only
        # good "until" then — observed in testing. Say which direction it runs.
        since = fees.get("effective")
        return {
            "city": data.city_name(city_id),
            "fees": fees,
            "note": (
                "City-wide rates, the same at every public pool."
                + (f" In force since {since} (that date is when they took effect, not an expiry)." if since else "")
                + " `dropIn` is the single-visit price; `passes` are multi-visit and membership options."
            ),
        }
    if topic == "closures":
        # The closure list is transcribed from the notes on the CURRENT seasonal
        # schedule PDFs, so it only ever covers the holidays inside that season's
        # window. Returned bare, it read as the whole year: asked about
        # Thanksgiving the assistant saw two summer holidays and could only say
        # "not listed", leaving the user to guess whether that meant open. The
        # season travels with it so an out-of-window date is answerable as "that
        # is past what the posted schedule covers" — which is true, and useful.
        seasons = sorted({
            season
            for court in data.courts_in(city_id, "swimming")
            if (season := ((court.get("pool") or {}).get("season")))
        })
        return {
            "city": data.city_name(city_id),
            "closures": data.REFERENCE.get("poolClosures"),
            "covers_season": seasons[0] if len(seasons) == 1 else seasons,
            "note": (
                "These are the closures printed on the current seasonal schedule, so the list "
                "only covers holidays falling inside that season. A date outside it is NOT "
                "confirmed open — say the posted schedule doesn't reach that far yet and point "
                "at the pool's own schedule link. Pools also close on other city holidays."
            ),
        }

    if not pool:
        # Each pool's status at the asked-about time, not just its name and
        # address. This listing already accepted `when` but answered without any
        # hours in it, and a model asked "which pools are open Wednesday evening"
        # filled the gap itself — inventing "Balboa Pool is open on Wednesday
        # evening... about 3.5 miles from you" from a payload containing neither
        # an opening time nor a distance. Carrying the status closes the gap.
        target = _resolve_when(when, city_id)
        listing = []
        for p in pools:
            status = tu.status_at(p["weeks"]["swimming"], target)
            entry = {
                "id": p["id"],
                "name": p["name"],
                "address": p.get("address"),
                "neighborhood": p.get("neighborhood"),
                "season": (p.get("pool") or {}).get("season"),
                "open": status["open"],
                "status": status["summary"],
            }
            distance = _distance_from(origin, p)
            if distance is not None:
                entry["miles_from_user"] = distance
            listing.append(entry)
        open_count = sum(1 for e in listing if e["open"])
        return {
            "city": data.city_name(city_id),
            "asked_about": target.label,
            "open_count": open_count,
            "pools": listing,
            "note": (
                "`open` and `status` are for the time asked about. State only what they say; "
                "no other opening time is available here. Name one pool for its full session "
                "schedule (lap, family, senior)."
            ),
        }

    found = _find_one_court(pool, city_id, "swimming")
    if isinstance(found, list):
        return {
            "ambiguous": True,
            "candidates": [{"id": p["id"], "name": p["name"]} for p in found[:8]],
        }

    block = found.get("pool") or {}
    target = _resolve_when(when, city_id)
    detail: dict = {
        "name": found["name"],
        "address": found.get("address"),
        "phone": found.get("phone") or block.get("phone"),
        "season": block.get("season"),
        "asked_about": target.label,
        "official_schedule": (block.get("scheduleUrls") or [None])[0],
    }
    if block.get("desc"):
        detail["about"] = block["desc"]

    if topic == "schedule":
        # Public-swim drop-in hours (the "just show up" ones) come from the same
        # resolved week the map uses; the full session list adds lessons/camps.
        detail["public_swim"] = tu.status_at(found["weeks"]["swimming"], target)["summary"]
        detail["public_swim_week"] = tu.week_rows(found["weeks"]["swimming"])
        sessions = (block.get("sessions") or [])
        day_sessions = sessions[target.dow] if target.dow < len(sessions) else []
        detail["all_sessions_that_day"] = [
            {
                "kind": s.get("kind"),
                "time": f"{tu.fmt_minutes(s['start'])}–{tu.fmt_minutes(s['end'])}",
                **({"pool": s["pool"]} if s.get("pool") else {}),
            }
            for s in day_sessions
        ]
        detail["session_kinds_here"] = block.get("programs")
        detail["caveat"] = "Seasonal schedule — the linked PDF is the source of truth."
    else:
        detail["public_swim_today"] = tu.status_at(found["weeks"]["swimming"], target)["summary"]
        detail["session_kinds_here"] = block.get("programs")
    return detail


# ---------------------------------------------------------------------------
# Tool: list_options
# ---------------------------------------------------------------------------


def list_options(city: str | None = None) -> dict:
    """What this city actually has — sports, class categories, available features.

    The grounding for "what can I do?", and the escape hatch when another tool
    rejects an argument: the valid values are always one call away.
    """
    city_id = _resolve_city(city)
    entry = data.city(city_id) or {}
    return {
        "city": data.city_name(city_id),
        "sports": data.sports_in(city_id),
        "class_categories": [
            {"id": c, "label": data.category_label(c)} for c in data.categories_in(city_id)
        ],
        "has_pools": data.has_feature(city_id, "pools"),
        "has_golf": data.has_feature(city_id, "golf"),
        "has_court_reservations": data.has_feature(city_id, "reservations"),
        "areas": entry.get("subregions"),
        "court_count": len(data.courts_in(city_id)),
        "class_count": len(data.classes_in(city_id)),
        "other_cities": [c["name"] for c in data.cities() if c["id"] != city_id],
    }


# The callable surface, by name. tools.py describes these to the model and the
# agent dispatches through this map — so a tool cannot be advertised without
# existing, or exist without being reachable.
TOOLS: dict[str, Callable[..., dict]] = {
    "find_courts": find_courts,
    "summarize_courts": summarize_courts,
    "get_court": get_court,
    "get_reservation_policy": get_reservation_policy,
    "find_classes": find_classes,
    "get_pool_info": get_pool_info,
    "list_options": list_options,
}

# Tools that accept an injected `origin` (the user's coordinates from app state).
# Kept explicit so tools.py never advertises it as a model-fillable argument.
ACCEPTS_ORIGIN = {"find_courts", "get_court", "find_classes", "get_pool_info"}
