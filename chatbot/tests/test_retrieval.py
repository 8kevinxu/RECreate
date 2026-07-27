"""Tests for the tool layer.

Two things get checked, and the second matters as much as the first:

1. The tools return the right facts.
2. The tools return *small* results, in the shape the model was promised.

(2) has no visible symptom in development — an oversized payload doesn't crash,
it just quietly makes answers worse. So payload size and the absence of the bulky
raw fields are asserted explicitly.

`when` is always absolute here, so nothing depends on when the suite runs.
"""

import json

import pytest

import data
import retrieval as r

SATURDAY_10AM = "2026-07-25T10:00"
SATURDAY = "2026-07-25"
FRIDAY_10PM = "2026-07-24T22:00"

# Roughly the Mission, for distance assertions.
MISSION_ORIGIN = (37.7599, -122.4148)


# ---------------------------------------------------------------------------
# Argument validation — errors are part of the interface
# ---------------------------------------------------------------------------


class TestArgumentErrors:
    def test_unknown_city_lists_the_real_ones(self):
        with pytest.raises(r.ToolError) as exc:
            r.find_courts(sport="basketball", city="paris")
        assert "sf" in str(exc.value) and "nyc" in str(exc.value)

    def test_missing_sport_lists_available_sports(self):
        with pytest.raises(r.ToolError) as exc:
            r.find_courts(city="sf")
        assert "basketball" in str(exc.value)

    def test_sport_absent_from_a_city_is_rejected_with_alternatives(self):
        # Swimming is SF-only; asking NYC must not silently serve SF pools.
        with pytest.raises(r.ToolError) as exc:
            r.find_courts(sport="swimming", city="nyc")
        assert "basketball" in str(exc.value)

    def test_bad_when_explains_the_accepted_forms(self):
        with pytest.raises(r.ToolError) as exc:
            r.find_courts(sport="basketball", city="sf", when="sometime next week")
        assert "saturday" in str(exc.value).lower()

    def test_unknown_class_category_lists_valid_ones(self):
        with pytest.raises(r.ToolError) as exc:
            r.find_classes(city="sf", category="underwater-basketweaving")
        assert "aquatics" in str(exc.value)

    def test_bad_pool_topic_lists_topics(self):
        with pytest.raises(r.ToolError) as exc:
            r.get_pool_info(topic="hours", city="sf")
        assert "fees" in str(exc.value)


class TestSportAliases:
    @pytest.mark.parametrize(
        "spoken,expected",
        [("ping pong", "pingpong"), ("table tennis", "pingpong"), ("hoops", "basketball"),
         ("weight room", "weightroom"), ("Basketball", "basketball"), ("swim", "swimming")],
    )
    def test_aliases_resolve(self, spoken, expected):
        assert r.find_courts(sport=spoken, city="sf", when=SATURDAY_10AM)["sport"] == expected


# ---------------------------------------------------------------------------
# find_courts
# ---------------------------------------------------------------------------


class TestFindCourts:
    def test_returns_courts_with_a_status_each(self):
        result = r.find_courts(sport="basketball", city="sf", when=SATURDAY_10AM)
        assert result["courts"]
        for court in result["courts"]:
            assert {"id", "name", "open", "status"} <= court.keys()

    def test_reports_how_many_matched_beyond_what_it_shows(self):
        result = r.find_courts(sport="basketball", city="sf", when=SATURDAY_10AM, limit=3)
        assert result["shown"] == 3
        assert result["matched"] > 3  # the model can say "there are more"

    def test_limit_is_capped(self):
        result = r.find_courts(sport="basketball", city="nyc", when=SATURDAY_10AM, limit=10_000)
        assert result["shown"] <= r.MAX_LIMIT

    def test_open_only_filters_and_still_counts_honestly(self):
        loose = r.find_courts(sport="basketball", city="sf", when=FRIDAY_10PM)
        strict = r.find_courts(sport="basketball", city="sf", when=FRIDAY_10PM, open_only=True)
        assert all(c["open"] for c in strict["courts"])
        assert strict["matched"] == loose["open_now_count"]

    def test_late_night_finds_nothing_open_and_says_so(self):
        result = r.find_courts(sport="basketball", city="sf", when="2026-07-25T03:00", open_only=True)
        assert result["courts"] == []
        assert "note" in result

    def test_open_courts_are_listed_first(self):
        result = r.find_courts(sport="basketball", city="sf", when=SATURDAY_10AM, limit=25)
        flags = [c["open"] for c in result["courts"]]
        assert flags == sorted(flags, reverse=True)

    def test_indoor_filter(self):
        result = r.find_courts(sport="basketball", city="sf", when=SATURDAY_10AM, indoor=True, limit=25)
        assert all(c["indoor"] for c in result["courts"])
        assert result["filtered_to"] == "indoor only"

    def test_outdoor_filter(self):
        result = r.find_courts(sport="tennis", city="sf", when=SATURDAY_10AM, indoor=False, limit=25)
        assert not any(c["indoor"] for c in result["courts"])

    def test_name_narrows_the_search(self):
        result = r.find_courts(sport="basketball", city="sf", name="Mission", when=SATURDAY_10AM)
        assert result["matched"] >= 1
        assert any("mission" in c["name"].lower() for c in result["courts"])

    def test_distance_appears_only_with_an_origin(self):
        without = r.find_courts(sport="basketball", city="sf", when=SATURDAY_10AM)
        assert "miles_from_user" not in without["courts"][0]
        assert "location unknown" in without["note"]

        with_origin = r.find_courts(
            sport="basketball", city="sf", when=SATURDAY_10AM, origin=MISSION_ORIGIN
        )
        assert all("miles_from_user" in c for c in with_origin["courts"])

    def test_nearest_first_when_location_is_known(self):
        result = r.find_courts(
            sport="basketball", city="sf", when=SATURDAY_10AM, open_only=True,
            origin=MISSION_ORIGIN, limit=10,
        )
        distances = [c["miles_from_user"] for c in result["courts"]]
        assert distances == sorted(distances)

    def test_the_judged_moment_is_always_stated(self):
        result = r.find_courts(sport="basketball", city="sf", when=SATURDAY_10AM)
        assert "Saturday" in result["asked_about"] and "10AM" in result["asked_about"]

    def test_a_whole_day_question_still_answers(self):
        # "open Saturday?" with no time — must not resolve to midnight and say closed.
        result = r.find_courts(sport="basketball", city="sf", when=SATURDAY, open_only=True)
        assert result["courts"], "a whole-day question found nothing open"
        assert "whole day" in result["asked_about"]

    def test_nyc_works_too(self):
        result = r.find_courts(sport="basketball", city="nyc", when=SATURDAY_10AM)
        assert result["city"] == "New York City"
        assert result["matched"] > 50


class TestFindCourtsPayload:
    """The raw booking snapshot must never ride along."""

    def test_slot_tables_are_projected_away(self):
        result = r.find_courts(sport="tennis", city="sf", when=SATURDAY_10AM, limit=25)
        blob = json.dumps(result)
        assert "slots" not in blob
        assert "released" not in blob
        assert "guidelines" not in blob

    def test_percent_booked_survives_the_projection(self):
        result = r.find_courts(sport="tennis", city="sf", when=SATURDAY_10AM, limit=25)
        assert any("percent_booked_overall" in c for c in result["courts"])

    def test_booking_is_reported_for_the_asked_about_time(self):
        # The whole-window average answers "how busy is this court", not "how
        # busy is it at 2pm on Tuesday" — and read as the latter it inverts the
        # answer: Rossi averaged 74% while being 100% booked at that moment.
        result = r.find_courts(sport="pickleball", city="sf", when="2026-07-28T14:00", limit=25)
        rossi = next(c for c in result["courts"] if c["id"].startswith("angelo-j-rossi"))
        assert rossi["percent_booked_at_asked_time"] == 100
        assert rossi["percent_booked_overall"] != rossi["percent_booked_at_asked_time"]

    def test_the_at_time_number_is_absent_rather_than_guessed(self):
        # Outside the published reservation window there is no honest number, so
        # the key must not appear at all — and the result must say why.
        result = r.find_courts(sport="pickleball", city="sf", when="2027-01-05T14:00", limit=25)
        assert all("percent_booked_at_asked_time" not in c for c in result["courts"])

    def test_a_full_result_stays_small(self):
        # A tool result is context the model must read. 25 courts should cost
        # single-digit KB, not the tens of KB the raw records would.
        result = r.find_courts(sport="tennis", city="sf", when=SATURDAY_10AM, limit=25)
        assert len(json.dumps(result)) < 8000

    def test_internal_fields_never_leak(self):
        blob = json.dumps(r.find_courts(sport="basketball", city="sf", when=SATURDAY_10AM, limit=25))
        assert "_norm" not in blob


class TestStructuralFilters:
    """Questions about the *shape* of a week or a facility, not one instant.

    Both of these used to be unanswerable in a way that produced confident wrong
    answers rather than an admission of ignorance: asking which courts have open
    play at 11PM returned none (no court is mid-session then), and asking which
    have a hitting wall returned "no hitting wall mentioned" while seven courts
    have one.
    """

    def test_open_play_is_found_whatever_time_is_asked_about(self):
        late = r.find_courts(sport="pickleball", city="sf", when=FRIDAY_10PM,
                             restriction="open play", limit=25)
        assert late["matched"] == 4
        names = {c["name"] for c in late["courts"]}
        assert "Angelo J. Rossi Playground" in names
        assert "Presidio Wall Playground" in names

    def test_open_play_windows_come_back_with_the_court(self):
        result = r.find_courts(sport="pickleball", city="sf", when=FRIDAY_10PM,
                               restriction="openplay", limit=25)
        rossi = next(c for c in result["courts"] if c["id"].startswith("angelo-j-rossi"))
        windows = {(w["day"], w["hours"]) for w in rossi["special_hours"]}
        assert ("Tuesday", "9AM–3PM") in windows
        assert ("Sunday", "9AM–5PM") in windows
        # Scoped to what was asked: no unrelated tag rides along.
        assert {w["restriction"] for w in rossi["special_hours"]} == {"open play"}

    def test_hitting_walls_are_findable(self):
        result = r.find_courts(sport="tennis", city="sf", amenity="hitting wall", limit=25)
        assert result["matched"] == 7
        names = {c["name"] for c in result["courts"]}
        assert "Alice Marble Tennis Courts" in names
        assert all(c["facilities"]["wall"] for c in result["courts"])

    def test_amenity_aliases_reach_the_same_field(self):
        for word in ("wall", "backboard", "practice wall"):
            assert r.find_courts(sport="tennis", city="sf", amenity=word)["matched"] == 7

    def test_an_unusable_filter_value_is_ignored_rather_than_fatal(self):
        # Failing the call costs a step and tends to end with the assistant
        # relaying the error: asked about open play, a model passed
        # amenity="openplay" and answered "'openplay' is not a valid amenity,
        # try lights, nets, reservable…". Answering approximately beats that.
        result = r.find_courts(sport="tennis", city="sf", amenity="sauna", limit=3)
        assert result["matched"] > 0
        assert "wall" in result["ignored_filters"]["amenity"]

    def test_a_value_in_the_wrong_parameter_says_where_it_belongs(self):
        openplay = r.find_courts(sport="pickleball", city="sf", amenity="openplay", limit=3)
        assert "`restriction`" in openplay["ignored_filters"]["amenity"]
        wall = r.find_courts(sport="tennis", city="sf", restriction="wall", limit=3)
        assert "`amenity`" in wall["ignored_filters"]["restriction"]

    def test_missing_facility_data_is_unknown_not_no(self):
        # Hitting walls aren't recorded for NYC. Answering "none have a wall"
        # would be inventing a fact; the result has to say it doesn't know.
        result = r.find_courts(sport="tennis", city="nyc", amenity="wall")
        assert result["matched"] == 0
        assert "UNKNOWN" in result["note_amenity_data"]

    def test_amenities_work_in_both_cities(self):
        # The two feeds spell facts differently — SF's directory writes `lights`,
        # NYC's Socrata records write `lit` — and the exporter normalizes them,
        # so one filter has to reach both without per-city handling.
        assert r.find_courts(sport="tennis", city="sf", amenity="lights")["matched"] > 0
        nyc = r.find_courts(sport="basketball", city="nyc", amenity="lights", limit=25)
        assert nyc["matched"] > 0
        assert "note_amenity_data" not in nyc

    def test_court_level_amenities_reach_each_sport(self):
        # `water` and `accessible` are recorded per park, not per sport, so a
        # filter asking "does this basketball court have water" must still find them.
        result = r.find_courts(sport="basketball", city="nyc", amenity="drinking water", limit=3)
        assert result["matched"] > 100
        assert all(c["facilities"]["water"] for c in result["courts"])

    def test_a_field_untracked_for_one_sport_is_also_unknown(self):
        # Tennis records carry facilities but never a `nets` key. Zero matches
        # there means "not tracked", not "no tennis court has nets".
        untracked = r.find_courts(sport="tennis", city="sf", amenity="nets", limit=25)
        assert untracked["matched"] == 0
        assert "UNKNOWN" in untracked["note_amenity_data"]
        # Pickleball does record it, so the same field must answer normally.
        tracked = r.find_courts(sport="pickleball", city="sf", amenity="nets", limit=25)
        assert tracked["matched"] == 13
        assert "note_amenity_data" not in tracked

    def test_an_empty_result_names_the_filter_that_emptied_it(self):
        # Every SF pool is indoor, so an invented `indoor=False` hides all nine —
        # and the assistant reported "there are no open swimming places". The
        # count is of courts that would actually be OPEN without that filter, so
        # the model can name Sava rather than promising nine unavailable pools.
        result = r.find_courts(sport="swimming", city="sf", when="2026-07-29T16:00",
                               indoor=False, open_only=True)
        assert result["matched"] == 0
        dropped = result["if_one_filter_is_dropped"]["without indoor"]
        assert dropped["count"] == 1
        # Named, so the model can say "Sava" instead of inventing a pool.
        assert dropped["examples"] == ["Sava Pool"]

    def test_each_relaxation_count_drops_only_its_own_filter(self):
        # Counting "how many survived just before this filter" is a different
        # number, and equals the truth only for whichever filter ran last.
        # Asking at 11:31PM with three filters is the case that exposed it.
        result = r.find_courts(sport="pickleball", city="sf", when="2026-07-26T23:31",
                               indoor=False, open_only=True, restriction="openplay")
        assert result["matched"] == 0
        relaxed = result["if_one_filter_is_dropped"]
        # Nothing is open at 11:31PM, so relaxing indoor or restriction changes
        # nothing and must not be offered as a way out. Only the time does.
        assert list(relaxed) == ["without open_only (these match but are CLOSED at that time)"]
        only = relaxed["without open_only (these match but are CLOSED at that time)"]
        assert only["count"] == 4
        assert "Angelo J. Rossi Playground" in only["examples"]

    def test_relaxations_name_the_places_rather_than_counting_them(self):
        # A bare count tells the model something exists without saying what, and
        # asked to name one it invents: from "4 courts without that filter" it
        # produced "a court called Mission Tennis Center" and "the court at 1000
        # Mason St" — neither exists in the data.
        result = r.find_courts(sport="pickleball", city="sf", when="2026-07-26T23:31",
                               open_only=True, restriction="openplay")
        every_name = {n for entry in result["if_one_filter_is_dropped"].values()
                      for n in entry["examples"]}
        real = {c["name"] for c in data.COURTS}
        assert every_name and every_name <= real


# ---------------------------------------------------------------------------
# get_court
# ---------------------------------------------------------------------------


class TestGetCourt:
    def test_by_id(self):
        detail = r.get_court("mission-recreation-center", sport="basketball")
        assert detail["name"] == "Mission Recreation Center"
        assert "basketball" in detail["schedules"]

    def test_returns_a_full_week(self):
        detail = r.get_court("mission-recreation-center", sport="basketball")
        week = detail["schedules"]["basketball"]["weekly_hours"]
        assert len(week) == 7
        assert week[0]["day"] == "Monday"

    def test_scoping_to_a_sport_omits_the_others(self):
        scoped = r.get_court("mission-recreation-center", sport="basketball")
        unscoped = r.get_court("mission-recreation-center")
        assert set(scoped["schedules"]) == {"basketball"}
        assert len(unscoped["schedules"]) > 1

    def test_by_name(self):
        detail = r.get_court("Mission Recreation Center", city="sf", sport="basketball")
        assert detail["id"] == "mission-recreation-center"

    def test_an_ambiguous_name_returns_candidates_rather_than_guessing(self):
        result = r.get_court("playground", city="sf")
        assert result.get("ambiguous")
        assert len(result["candidates"]) > 1
        assert all({"id", "name"} <= c.keys() for c in result["candidates"])

    def test_an_unknown_name_errors_with_a_next_step(self):
        with pytest.raises(r.ToolError) as exc:
            r.get_court("Wembley Stadium", city="sf")
        assert "find_courts" in str(exc.value)

    def test_facilities_are_included_when_known(self):
        detail = r.get_court("alamo-square-outdoor", sport="tennis")
        assert detail["schedules"]["tennis"]["facilities"]["total"] == 1

    def test_reservation_numbers_without_the_slot_table(self):
        detail = r.get_court("alice-marble-tennis-courts-outdoor", sport="tennis")
        reservations = detail["schedules"]["tennis"]["reservations"]
        assert isinstance(reservations["percent_booked_overall"], int)
        assert "slots" not in json.dumps(detail)

    def test_a_pool_points_at_the_pool_tool(self):
        detail = r.get_court("pool-balboa", sport="swimming")
        assert detail["is_pool"] is True
        assert "get_pool_info" in detail["note_pool"]

    def test_detail_stays_small(self):
        detail = r.get_court("alice-marble-tennis-courts-outdoor", sport="tennis")
        assert len(json.dumps(detail)) < 3000


class TestReservationPolicy:
    def test_returns_the_posted_policy(self):
        result = r.get_reservation_policy("alice-marble-tennis-courts-outdoor")
        assert "Reservation Policy" in result["policy"]
        assert result["booking_urls"]

    def test_walk_up_courts_say_so(self):
        result = r.get_reservation_policy("mission-recreation-center")
        assert "policy" not in result
        assert "walk-up" in result["note"]


# ---------------------------------------------------------------------------
# find_classes
# ---------------------------------------------------------------------------


class TestFindClasses:
    def test_returns_classes_with_the_practical_fields(self):
        result = r.find_classes(city="sf")
        assert result["classes"]
        assert {"id", "name", "category"} <= result["classes"][0].keys()

    def test_category_filter(self):
        result = r.find_classes(city="sf", category="aquatics", limit=25)
        assert result["matched"] > 0
        assert all(c["category"] == "Aquatics" for c in result["classes"])
        assert "category=aquatics" in result["filters"]

    def test_query_matches_names(self):
        result = r.find_classes(city="sf", query="swim", limit=10)
        assert any("swim" in c["name"].lower() for c in result["classes"])

    def test_openings_only(self):
        result = r.find_classes(city="sf", openings_only=True, limit=25)
        assert all(c.get("openings") for c in result["classes"])

    def test_free_only(self):
        result = r.find_classes(city="sf", free_only=True, limit=25)
        assert all(c["cost"].lower().startswith("free") for c in result["classes"])

    def test_age_filter_respects_the_catalog_bounds(self):
        result = r.find_classes(city="sf", age=8, limit=25)
        for entry in result["classes"]:
            source = data.klass(entry["id"])
            assert source.get("minAge") is None or source["minAge"] <= 8
            assert source.get("maxAge") is None or source["maxAge"] >= 8

    def test_day_filter(self):
        result = r.find_classes(city="sf", day="saturday", limit=25)
        assert result["matched"] > 0
        assert all("sat" in data.klass(c["id"])["when"].lower() for c in result["classes"])

    def test_filters_compose(self):
        result = r.find_classes(city="sf", category="aquatics", free_only=True, limit=25)
        assert len(result["filters"]) == 2

    def test_impossible_filters_return_a_hint_not_a_crash(self):
        result = r.find_classes(city="sf", category="aquatics", query="quantum astrophysics")
        assert result["classes"] == []
        assert "note" in result

    def test_nyc_catalog_is_reachable(self):
        assert r.find_classes(city="nyc")["matched"] > 0

    def test_payload_stays_small(self):
        assert len(json.dumps(r.find_classes(city="sf", limit=25))) < 12000


# ---------------------------------------------------------------------------
# get_pool_info
# ---------------------------------------------------------------------------


class TestGetPoolInfo:
    def test_fees_return_fees_and_nothing_else(self):
        result = r.get_pool_info(topic="fees", city="sf")
        assert result["fees"]
        # The regression this narrowness exists for: no pool catalog riding along.
        assert "pools" not in result
        assert "sessions" not in json.dumps(result)

    def test_fee_payload_is_tiny(self):
        assert len(json.dumps(r.get_pool_info(topic="fees", city="sf"))) < 2500

    def test_listing_pools_when_none_is_named(self):
        result = r.get_pool_info(topic="general", city="sf")
        assert len(result["pools"]) == 9
        assert all("name" in p for p in result["pools"])

    def test_a_named_pool_returns_its_schedule(self):
        result = r.get_pool_info(topic="schedule", pool="Balboa", city="sf", when=SATURDAY_10AM)
        assert "Balboa" in result["name"]
        assert len(result["public_swim_week"]) == 7
        assert result["all_sessions_that_day"]
        assert result["official_schedule"]

    def test_schedule_distinguishes_public_swim_from_all_sessions(self):
        # Lessons and camps appear in the day's sessions but are not drop-in swim.
        result = r.get_pool_info(topic="schedule", pool="Balboa", city="sf", when=SATURDAY_10AM)
        kinds = {s["kind"] for s in result["all_sessions_that_day"]}
        assert kinds  # the full picture is available
        assert "public_swim" in result  # while drop-in stays separately stated

    def test_closures(self):
        assert "closures" in r.get_pool_info(topic="closures", city="sf")

    def test_nyc_is_told_there_are_no_pools(self):
        result = r.get_pool_info(topic="fees", city="nyc")
        assert result["unavailable"] is True
        assert "San Francisco" in result["note"]

    def test_ambiguous_pool_names_return_candidates(self):
        result = r.get_pool_info(topic="schedule", pool="pool", city="sf")
        assert result.get("ambiguous") or result.get("name")


# ---------------------------------------------------------------------------
# list_options
# ---------------------------------------------------------------------------


class TestPoolListingCarriesHours:
    """The listing accepts `when`, so it must answer with hours at that time.

    It used to return only name/address/season. Asked "which pools are open
    Wednesday evening", the model invented "Balboa Pool is open on Wednesday
    evening... about 3.5 miles from you" — from a payload with neither an opening
    time nor a distance in it.
    """

    def test_each_pool_carries_its_status_at_the_asked_time(self):
        listing = r.get_pool_info(topic="general", city="sf", when="2026-07-29T16:00")
        assert listing["asked_about"]
        assert all("open" in p and "status" in p for p in listing["pools"])
        # Wednesday 4PM: exactly one pool is open, and it is Sava.
        assert listing["open_count"] == 1
        assert [p["name"] for p in listing["pools"] if p["open"]] == ["Sava Pool"]

    def test_distance_is_given_when_the_app_knows_where_the_user_is(self):
        listing = r.get_pool_info(topic="general", city="sf", origin=MISSION_ORIGIN)
        assert all("miles_from_user" in p for p in listing["pools"])

    def test_no_distance_is_invented_without_a_location(self):
        listing = r.get_pool_info(topic="general", city="sf")
        assert all("miles_from_user" not in p for p in listing["pools"])


class TestListOptions:
    def test_sf_capabilities(self):
        options = r.list_options("sf")
        assert "basketball" in options["sports"]
        assert options["has_pools"] is True
        assert options["has_golf"] is True
        assert options["court_count"] > 0

    def test_nyc_capabilities_differ(self):
        options = r.list_options("nyc")
        assert options["has_pools"] is False
        assert "Bronx" in options["areas"]

    def test_categories_carry_labels(self):
        options = r.list_options("sf")
        assert any(c["label"] == "Aquatics" for c in options["class_categories"])

    def test_points_at_the_other_city(self):
        assert r.list_options("sf")["other_cities"] == ["New York City"]


# ---------------------------------------------------------------------------
# The registry
# ---------------------------------------------------------------------------


class TestRegistry:
    def test_every_registered_tool_is_callable(self):
        assert all(callable(fn) for fn in r.TOOLS.values())

    def test_the_registry_covers_the_public_tools(self):
        assert set(r.TOOLS) == {
            "find_courts", "get_court", "get_reservation_policy",
            "find_classes", "get_pool_info", "list_options",
        }

    def test_origin_accepting_tools_really_accept_it(self):
        import inspect

        for name in r.ACCEPTS_ORIGIN:
            assert "origin" in inspect.signature(r.TOOLS[name]).parameters

    def test_origin_is_keyword_only_so_a_model_cannot_fill_it(self):
        import inspect

        for name in r.ACCEPTS_ORIGIN:
            param = inspect.signature(r.TOOLS[name]).parameters["origin"]
            assert param.kind is inspect.Parameter.KEYWORD_ONLY

    def test_every_tool_returns_json_serializable_output(self):
        results = [
            r.find_courts(sport="basketball", city="sf", when=SATURDAY_10AM),
            r.get_court("mission-recreation-center", sport="basketball"),
            r.get_reservation_policy("alice-marble-tennis-courts-outdoor"),
            r.find_classes(city="sf"),
            r.get_pool_info(topic="fees", city="sf"),
            r.list_options("sf"),
        ]
        for result in results:
            json.dumps(result)  # raises if anything unserializable slipped in
