"""Tests for the snapshot loader.

These run against the REAL exported snapshots on purpose. data.py's whole job is
being a faithful view of what `npm run export:chatbot` produced, so testing it
against fixtures would only prove the fixtures agree with themselves. The
assertions stay shape-and-invariant based (never "SF has exactly 138 courts") so
a normal data refresh doesn't turn them red.
"""

import data


def test_snapshots_loaded():
    assert len(data.COURTS) > 500
    assert len(data.CLASSES) > 200
    assert data.REFERENCE.get("generatedAt")


def test_both_cities_present():
    ids = {c["id"] for c in data.cities()}
    assert {"sf", "nyc"} <= ids


def test_lookup_by_id_round_trips():
    sample = data.COURTS[0]
    assert data.court(sample["id"]) is sample
    assert data.court("no-such-court") is None


def test_courts_by_city_partitions_the_whole_list():
    total = sum(len(data.courts_in(c["id"])) for c in data.cities())
    assert total == len(data.COURTS)


def test_sport_index_only_holds_courts_that_offer_the_sport():
    # The exporter drops sports with an empty week, so membership in the index
    # must imply real, non-empty hours — this is what lets retrieval skip its own
    # "is it actually offered?" check.
    for court in data.courts_in("sf", "basketball"):
        week = court["weeks"]["basketball"]
        assert len(week) == 7
        assert any(day for day in week)


def test_city_filter_actually_filters():
    for court in data.courts_in("nyc"):
        assert court["city"] == "nyc"
    assert not [c for c in data.courts_in("sf") if c["city"] != "sf"]


def test_swimming_is_a_sport_and_pools_carry_their_detail():
    pools = data.courts_in("sf", "swimming")
    assert len(pools) >= 5
    assert all(p.get("pool") for p in pools)


def test_timezones_differ_between_cities():
    # The reason city matters at all for "open now".
    assert data.timezone("sf") == "America/Los_Angeles"
    assert data.timezone("nyc") == "America/New_York"
    assert data.timezone(None) == data.timezone("sf")  # default city


def test_pools_are_an_sf_only_feature():
    assert data.has_feature("sf", "pools")
    assert not data.has_feature("nyc", "pools")


def test_sports_and_categories_are_non_empty_per_city():
    assert "basketball" in data.sports_in("sf")
    assert "basketball" in data.sports_in("nyc")
    assert data.categories_in("sf")
    assert data.categories_in("nyc")


def test_category_labels_resolve():
    assert data.category_label("aquatics") == "Aquatics"
    assert data.category_label("not-a-category") == "not-a-category"


def test_class_city_filter():
    for cls in data.classes_in("nyc"):
        assert cls["city"] == "nyc"


def test_class_category_filter():
    cat = data.categories_in("sf")[0]
    picked = data.classes_in("sf", cat)
    assert picked
    assert all(c["category"] == cat for c in picked)


class TestNormalize:
    def test_case_and_punctuation(self):
        assert data.normalize("Mission Rec. Center") == "mission rec center"

    def test_accents_fold_to_ascii(self):
        assert data.normalize("Café Español") == "cafe espanol"

    def test_empty_and_none(self):
        assert data.normalize(None) == ""
        assert data.normalize("   ") == ""

    def test_tokens_are_a_set(self):
        assert data.tokens("Mission Recreation Center") == {"mission", "recreation", "center"}


def test_every_court_has_a_searchable_name():
    assert all(c["_norm"] for c in data.COURTS)


def test_stats_reports_the_world():
    s = data.stats()
    assert s["courts"] == len(data.COURTS)
    assert s["courtsByCity"]["sf"] > 0
    assert "basketball" in s["sports"]
