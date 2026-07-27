"""Loads the exported snapshots and indexes them for fast lookup.

This module is the assistant's whole world. Everything it can truthfully say
comes from here, and it deliberately does nothing else — no filtering policy, no
scoring, no schedule interpretation. Those are retrieval's job (retrieval.py).
Keeping the boundary sharp means retrieval can be tested against a handful of
fake records without touching the real 872.

Data arrives from `npm run export:chatbot`, which resolves every court's weekly
schedule using the app's own lib/hours.js. See chatbot/data/reference.json ->
"format" for the encodings; the two that matter constantly:

    weekday index   0 = Sunday .. 6 = Saturday
    times           minutes from midnight, LOCAL TO THE COURT'S CITY

That last point is why city timezones live in this module. "Open right now" for
a Brooklyn court is a question about New York's clock, not the server's, and the
snapshot carries no timezone of its own — only the city id that resolves to one.

Snapshots are read once at import. They're static build artifacts, so a reload
means restarting the service (or calling reload() in a REPL).
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import Any, Iterable

DATA_DIR = Path(__file__).parent / "data"

# Every court belongs to a city, and every city keeps its own clock.
DEFAULT_CITY = "sf"


class SnapshotMissing(RuntimeError):
    """Raised with instructions rather than letting a FileNotFoundError escape."""


def _read(name: str) -> Any:
    path = DATA_DIR / name
    try:
        return json.loads(path.read_text())
    except FileNotFoundError as exc:
        raise SnapshotMissing(
            f"Missing {path}.\n"
            "The assistant reads snapshots exported from the app's data modules.\n"
            "Generate them first:\n"
            "    cd .. && npm run export:chatbot"
        ) from exc


# ---------------------------------------------------------------------------
# Name normalization
# ---------------------------------------------------------------------------
# Precomputed once per record so retrieval can match names with a linear scan.
# 872 courts is small enough that a scan over prepared strings costs well under a
# millisecond — an inverted index here would be complexity with nothing to show
# for it. What actually matters is that normalization is applied to BOTH sides,
# the stored name and the user's words, so "Mission Rec" can reach
# "Mission Recreation Center".

_PUNCT = re.compile(r"[^a-z0-9]+")


def normalize(text: str | None) -> str:
    """Casefold, strip accents and punctuation, collapse whitespace."""
    if not text:
        return ""
    # NFKD splits "é" into "e" + combining accent, which the ASCII filter drops.
    decomposed = unicodedata.normalize("NFKD", str(text))
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return _PUNCT.sub(" ", stripped.lower()).strip()


def tokens(text: str | None) -> set[str]:
    """Normalized word set, for overlap scoring in retrieval."""
    return set(normalize(text).split())


# ---------------------------------------------------------------------------
# State, populated by load()
# ---------------------------------------------------------------------------

COURTS: list[dict] = []
CLASSES: list[dict] = []
REFERENCE: dict = {}

_courts_by_id: dict[str, dict] = {}
_classes_by_id: dict[str, dict] = {}
_courts_by_city: dict[str, list[dict]] = {}
_classes_by_city: dict[str, list[dict]] = {}
# (city, sport) -> courts offering it. The single hottest query the assistant
# makes, so it's precomputed rather than filtered per question.
_courts_by_city_sport: dict[tuple[str, str], list[dict]] = {}
_cities_by_id: dict[str, dict] = {}
# category id -> {"id", "label", "emoji"}; the snapshot ships these as a list.
_categories_by_id: dict[str, dict] = {}


def load() -> None:
    """Read the snapshots and build every index. Idempotent."""
    global COURTS, CLASSES, REFERENCE

    COURTS = _read("courts.json")
    CLASSES = _read("classes.json")
    REFERENCE = _read("reference.json")

    _courts_by_id.clear()
    _classes_by_id.clear()
    _courts_by_city.clear()
    _classes_by_city.clear()
    _courts_by_city_sport.clear()
    _cities_by_id.clear()
    _categories_by_id.clear()

    for city in REFERENCE.get("cities", []):
        _cities_by_id[city["id"]] = city

    for cat in REFERENCE.get("classCategories", []):
        _categories_by_id[cat["id"]] = cat

    for court in COURTS:
        cid = court.get("city") or DEFAULT_CITY
        court["city"] = cid
        # Searchable text: the name plus its neighborhood, so "Mission" finds
        # both the rec center and the courts sitting in the Mission.
        court["_norm"] = normalize(court.get("name"))
        court["_norm_where"] = normalize(
            " ".join(filter(None, [court.get("name"), court.get("neighborhood"), court.get("address")]))
        )
        _courts_by_id[court["id"]] = court
        _courts_by_city.setdefault(cid, []).append(court)
        for sport in court.get("sports", []):
            _courts_by_city_sport.setdefault((cid, sport), []).append(court)

    for cls in CLASSES:
        cid = cls.get("city") or DEFAULT_CITY
        cls["city"] = cid
        cls["_norm"] = normalize(cls.get("name"))
        cls["_norm_where"] = normalize(cls.get("location"))
        _classes_by_id[cls["id"]] = cls
        _classes_by_city.setdefault(cid, []).append(cls)


def reload() -> None:
    """Re-read snapshots after a fresh export (handy in a REPL)."""
    load()


# ---------------------------------------------------------------------------
# Cities
# ---------------------------------------------------------------------------


def cities() -> list[dict]:
    return REFERENCE.get("cities", [])


def city(city_id: str | None) -> dict | None:
    return _cities_by_id.get(city_id or DEFAULT_CITY)


def city_name(city_id: str | None) -> str:
    c = city(city_id)
    return c["name"] if c else str(city_id or DEFAULT_CITY)


def timezone(city_id: str | None) -> str:
    """IANA timezone for a city — the clock its schedules are written against."""
    c = city(city_id)
    return c.get("tz", "America/Los_Angeles") if c else "America/Los_Angeles"


def has_feature(city_id: str | None, feature: str) -> bool:
    """Whether a city has a data domain at all.

    Guards answers that would otherwise be quietly wrong: pools are SF-only, so
    a swimming question from New York must say "we don't have that here" rather
    than serve San Francisco's pools to someone in Queens.
    """
    c = city(city_id)
    return bool(c and c.get("features", {}).get(feature))


# ---------------------------------------------------------------------------
# Courts
# ---------------------------------------------------------------------------


def court(court_id: str) -> dict | None:
    return _courts_by_id.get(court_id)


def courts_in(city_id: str | None = None, sport: str | None = None) -> list[dict]:
    """Courts in a city, optionally narrowed to one sport.

    A court appears under a sport only when it actually offers it — the exporter
    drops sports whose week is empty — so this needs no further filtering.
    """
    if sport:
        if city_id:
            return list(_courts_by_city_sport.get((city_id, sport), []))
        return [c for (_, s), lst in _courts_by_city_sport.items() if s == sport for c in lst]
    if city_id:
        return list(_courts_by_city.get(city_id, []))
    return list(COURTS)


def sports_in(city_id: str | None = None) -> list[str]:
    """Sports that actually have courts in a city, alphabetically."""
    if city_id:
        return sorted({s for (c, s) in _courts_by_city_sport if c == city_id})
    return sorted({s for (_, s) in _courts_by_city_sport})


# ---------------------------------------------------------------------------
# Classes
# ---------------------------------------------------------------------------


def klass(class_id: str) -> dict | None:
    """`class` is a keyword, hence the spelling."""
    return _classes_by_id.get(class_id)


def classes_in(city_id: str | None = None, category: str | None = None) -> list[dict]:
    found: Iterable[dict] = _classes_by_city.get(city_id, []) if city_id else CLASSES
    if category:
        found = (c for c in found if c.get("category") == category)
    return list(found)


def categories_in(city_id: str | None = None) -> list[str]:
    """Class categories present in a city, alphabetically."""
    return sorted({c["category"] for c in classes_in(city_id) if c.get("category")})


def category_label(category: str) -> str:
    """Human label for a category id ('aquatics' -> 'Aquatics'), else the id."""
    entry = _categories_by_id.get(category)
    return entry.get("label", category) if entry else category


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------


def stats() -> dict:
    """Shape of the loaded world — surfaced by the service's /health endpoint."""
    return {
        "generatedAt": REFERENCE.get("generatedAt"),
        "cities": [c["id"] for c in cities()],
        "courts": len(COURTS),
        "classes": len(CLASSES),
        "courtsByCity": {c: len(v) for c, v in sorted(_courts_by_city.items())},
        "classesByCity": {c: len(v) for c, v in sorted(_classes_by_city.items())},
        "sports": sports_in(),
    }


load()
