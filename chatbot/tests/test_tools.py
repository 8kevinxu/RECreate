"""Tests for the tool schemas.

The failure these guard against is specific and nasty: the model is told about an
argument, fills it correctly, and the turn dies because the function never had
that parameter. Nothing in the model's behaviour is wrong, and the bug lives in a
file nobody looks at. So the schemas are checked against real signatures, and the
enums against real data.
"""

import inspect
import json

import pytest

import data
import retrieval
import tools


# ---------------------------------------------------------------------------
# Schema / function agreement
# ---------------------------------------------------------------------------


class TestSchemasMatchFunctions:
    def test_every_tool_has_a_schema(self):
        assert set(tools.SCHEMAS) == set(retrieval.TOOLS)

    @pytest.mark.parametrize("name", tools.names())
    def test_advertised_arguments_all_exist(self, name):
        parameters = inspect.signature(retrieval.TOOLS[name]).parameters
        for prop in tools.SCHEMAS[name]["properties"]:
            assert prop in parameters, f"{name} advertises {prop!r} but cannot accept it"

    @pytest.mark.parametrize("name", tools.names())
    def test_required_arguments_are_real(self, name):
        parameters = inspect.signature(retrieval.TOOLS[name]).parameters
        for required in tools.SCHEMAS[name]["required"]:
            assert required in parameters

    @pytest.mark.parametrize("name", tools.names())
    def test_origin_is_never_advertised(self, name):
        # Coordinates come from app state. A model asked for a latitude invents one.
        assert "origin" not in tools.SCHEMAS[name]["properties"]

    def test_the_import_time_guard_catches_drift(self, monkeypatch):
        monkeypatch.setitem(
            tools.SCHEMAS,
            "list_options",
            {"description": "x", "properties": {"nonexistent_arg": {"type": "string"}}, "required": []},
        )
        with pytest.raises(RuntimeError, match="does not accept"):
            tools._assert_schemas_match_functions()

    def test_the_guard_also_catches_an_advertised_origin(self, monkeypatch):
        monkeypatch.setitem(
            tools.SCHEMAS,
            "find_courts",
            {"description": "x", "properties": {"origin": {"type": "string"}}, "required": []},
        )
        with pytest.raises(RuntimeError, match="origin"):
            tools._assert_schemas_match_functions()


# ---------------------------------------------------------------------------
# Enums track the data
# ---------------------------------------------------------------------------


class TestEnums:
    def test_sport_enum_is_the_real_union(self):
        assert set(tools.ALL_SPORTS) == set(data.sports_in("sf")) | set(data.sports_in("nyc"))

    def test_sport_enum_includes_the_city_specific_ones(self):
        # Present because SF has them, even though NYC does not — retrieval
        # rejects the mismatch per city with a helpful message.
        assert {"swimming", "golf"} <= set(tools.ALL_SPORTS)

    def test_category_enum_matches_the_catalog(self):
        assert "aquatics" in tools.ALL_CATEGORIES
        assert set(tools.ALL_CATEGORIES) >= set(data.categories_in("sf"))

    def test_city_enum_matches_the_registry(self):
        assert tools.CITY_IDS == [c["id"] for c in data.cities()]

    def test_enumerated_sports_are_all_actually_callable(self):
        for sport in tools.ALL_SPORTS:
            city = "sf" if sport in data.sports_in("sf") else "nyc"
            result = tools.call("find_courts", {"sport": sport, "city": city})
            assert result["sport"] == sport


# ---------------------------------------------------------------------------
# Descriptions — the actual prompt surface
# ---------------------------------------------------------------------------


class TestDescriptions:
    @pytest.mark.parametrize("name", tools.names())
    def test_every_tool_is_described_substantially(self, name):
        assert len(tools.SCHEMAS[name]["description"]) > 80

    @pytest.mark.parametrize("name", tools.names())
    def test_every_property_is_described(self, name):
        for prop, spec in tools.SCHEMAS[name]["properties"].items():
            assert spec.get("description"), f"{name}.{prop} has no description"

    def test_the_when_grammar_warns_against_inventing_a_time(self):
        # The regression: a model appending 00:00 to a question with no time in it.
        assert "never 'saturday 00:00'" in tools.WHEN_DESCRIPTION

    def test_tools_point_at_each_other(self):
        # Selection guidance, so the model doesn't reach for find_courts to answer
        # a fees question.
        assert "get_court" in tools.SCHEMAS["find_courts"]["description"]
        assert "find_courts" in tools.SCHEMAS["find_classes"]["description"]


# ---------------------------------------------------------------------------
# Provider envelopes
# ---------------------------------------------------------------------------


class TestProviderFormats:
    def test_anthropic_shape(self):
        for spec in tools.for_anthropic():
            assert set(spec) == {"name", "description", "input_schema"}
            assert spec["input_schema"]["type"] == "object"
            assert "properties" in spec["input_schema"]

    def test_openai_shape(self):
        for spec in tools.for_openai():
            assert spec["type"] == "function"
            assert set(spec["function"]) == {"name", "description", "parameters"}
            assert spec["function"]["parameters"]["type"] == "object"

    def test_both_envelopes_carry_the_same_tools(self):
        anthropic = {s["name"] for s in tools.for_anthropic()}
        openai = {s["function"]["name"] for s in tools.for_openai()}
        assert anthropic == openai == set(tools.names())

    def test_both_envelopes_carry_identical_schemas(self):
        # Switching provider must not change what the model can ask for.
        anthropic = {s["name"]: s["input_schema"] for s in tools.for_anthropic()}
        openai = {s["function"]["name"]: s["function"]["parameters"] for s in tools.for_openai()}
        assert anthropic == openai

    def test_everything_is_json_serializable(self):
        json.dumps(tools.for_anthropic())
        json.dumps(tools.for_openai())

    def test_the_whole_tool_block_is_a_reasonable_prompt_size(self):
        # These descriptions ride along on every single request.
        assert len(json.dumps(tools.for_anthropic())) < 12000


# ---------------------------------------------------------------------------
# Argument sanitizing
# ---------------------------------------------------------------------------


class TestPrepareArgs:
    def test_passes_good_arguments_through(self):
        assert tools.prepare_args("find_courts", {"sport": "tennis", "limit": 3}) == {
            "sport": "tennis",
            "limit": 3,
        }

    def test_drops_hallucinated_arguments(self):
        cleaned = tools.prepare_args("find_courts", {"sport": "tennis", "vibe": "chill"})
        assert cleaned == {"sport": "tennis"}

    @pytest.mark.parametrize("given,expected", [("true", True), ("True", True), (True, True),
                                               ("yes", True), ("false", False), ("no", False), (False, False)])
    def test_coerces_stringly_typed_booleans(self, given, expected):
        assert tools.prepare_args("find_courts", {"open_only": given})["open_only"] is expected

    @pytest.mark.parametrize("given,expected", [("5", 5), (5, 5), (5.0, 5), ("5.9", 5)])
    def test_coerces_stringly_typed_integers(self, given, expected):
        assert tools.prepare_args("find_courts", {"limit": given})["limit"] == expected

    def test_unintelligible_values_are_omitted_so_defaults_apply(self):
        assert "limit" not in tools.prepare_args("find_courts", {"limit": "lots"})
        assert "open_only" not in tools.prepare_args("find_courts", {"open_only": "maybe"})

    def test_nulls_are_omitted(self):
        assert tools.prepare_args("find_courts", {"sport": "tennis", "when": None}) == {"sport": "tennis"}

    def test_empty_and_missing_arguments_are_fine(self):
        assert tools.prepare_args("list_options", None) == {}
        assert tools.prepare_args("list_options", {}) == {}

    def test_unknown_tool_names_the_real_ones(self):
        with pytest.raises(retrieval.ToolError) as exc:
            tools.prepare_args("find_pizza", {})
        assert "find_courts" in str(exc.value)


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


class TestCall:
    def test_dispatches_and_returns_the_tool_result(self):
        result = tools.call("find_courts", {"sport": "basketball", "city": "sf", "when": "2026-07-25T10:00"})
        assert result["sport"] == "basketball"

    def test_injects_origin_for_tools_that_take_it(self):
        result = tools.call(
            "find_courts",
            {"sport": "basketball", "city": "sf", "when": "2026-07-25T10:00"},
            origin=(37.7599, -122.4148),
        )
        assert all("miles_from_user" in c for c in result["courts"])

    def test_does_not_inject_origin_where_it_is_unsupported(self):
        # list_options takes no origin; passing one must not blow up.
        assert tools.call("list_options", {"city": "sf"}, origin=(37.7, -122.4))["city"]

    def test_survives_a_messy_model_call(self):
        # Stringly-typed booleans, a junk argument, and a sport alias at once.
        result = tools.call(
            "find_courts",
            {"sport": "ping pong", "city": "sf", "open_only": "true", "limit": "2", "mood": "energetic"},
        )
        assert result["sport"] == "pingpong"
        assert result["shown"] <= 2

    def test_tool_errors_still_surface_for_the_model_to_read(self):
        with pytest.raises(retrieval.ToolError) as exc:
            tools.call("find_courts", {"sport": "quidditch", "city": "sf"})
        assert "basketball" in str(exc.value)

    def test_every_tool_is_reachable_through_dispatch(self):
        calls = {
            "find_courts": {"sport": "basketball", "city": "sf"},
            "get_court": {"court": "mission-recreation-center", "sport": "basketball"},
            "get_reservation_policy": {"court": "alice-marble-tennis-courts-outdoor"},
            "find_classes": {"city": "sf", "limit": 2},
            "get_pool_info": {"topic": "fees", "city": "sf"},
            "list_options": {"city": "sf"},
        }
        assert set(calls) == set(tools.names())
        for name, args in calls.items():
            json.dumps(tools.call(name, args))


def test_describe_for_humans_lists_every_tool():
    description = tools.describe_for_humans()
    for name in tools.names():
        assert name in description
