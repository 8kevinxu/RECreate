"""Tests for the loop.

The model is replaced by a scripted fake that returns a fixed sequence of
replies. That makes the loop's behavior — how many steps it takes, what it does
when a tool fails, what it injects — fully deterministic and testable with no
network, no key, and no Ollama running.

The tools themselves are real: this exercises the actual seam from a tool call
through retrieval and back, which is where the interesting bugs live.
"""

import json

import pytest

import agent
import config
import llm
import tools


class ScriptedProvider:
    """A model that returns pre-written replies in order.

    Records every `chat()` call so tests can assert on what the loop sent —
    including whether tools were offered on the final turn.
    """

    name = "scripted"
    model = "scripted-1"

    def __init__(self, *replies: llm.Reply):
        self.replies = list(replies)
        self.calls: list[dict] = []

    def chat(self, system, messages, tools=None):
        self.calls.append({"system": system, "messages": [dict(m) for m in messages], "tools": tools})
        if not self.replies:
            return llm.Reply(text="(ran out of scripted replies)")
        return self.replies.pop(0)

    def health(self):
        return {"provider": self.name}


def call(name, arguments, call_id="tu_1"):
    return llm.ToolCall(id=call_id, name=name, arguments=arguments)


def ask(question, *replies, state=None, debug=False):
    provider = ScriptedProvider(*replies)
    result = agent.answer([{"role": "user", "content": question}], state or {"city": "sf"},
                          debug=debug, provider=provider)
    return result, provider


# ---------------------------------------------------------------------------
# The happy path
# ---------------------------------------------------------------------------


class TestBasicLoop:
    def test_an_answer_with_no_tools_returns_immediately(self):
        result, provider = ask("what is this app?", llm.Reply(text="RECreate finds courts."))
        assert result.reply == "RECreate finds courts."
        assert result.steps == []
        assert len(provider.calls) == 1
        assert result.stopped_because == "answered"

    def test_one_tool_call_then_an_answer(self):
        result, provider = ask(
            "any basketball open saturday at 10?",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball", "when": "2026-07-25T10:00"})]),
            llm.Reply(text="Yes — several courts are open."),
        )
        assert result.reply == "Yes — several courts are open."
        assert [s.tool for s in result.steps] == ["find_courts"]
        assert result.steps[0].ok
        assert result.steps[0].result_chars > 0
        assert len(provider.calls) == 2

    def test_the_tool_result_is_fed_back_to_the_model(self):
        _, provider = ask(
            "pool fees?",
            llm.Reply(tool_calls=[call("get_pool_info", {"topic": "fees"})]),
            llm.Reply(text="Adults are $8."),
        )
        second_turn = provider.calls[1]["messages"]
        assert second_turn[-2]["role"] == "assistant"
        assert second_turn[-1]["role"] == "tool"
        assert "fees" in second_turn[-1]["content"]

    def test_parallel_calls_all_run(self):
        result, _ = ask(
            "pool hours and price?",
            llm.Reply(tool_calls=[
                call("get_pool_info", {"topic": "schedule", "pool": "Balboa"}, "a"),
                call("get_pool_info", {"topic": "fees"}, "b"),
            ]),
            llm.Reply(text="Open 9-5, $8 for adults."),
        )
        assert len(result.steps) == 2
        assert all(s.ok for s in result.steps)

    def test_several_sequential_tool_calls(self):
        result, _ = ask(
            "compare two courts",
            llm.Reply(tool_calls=[call("get_court", {"court": "mission-recreation-center"}, "a")]),
            llm.Reply(tool_calls=[call("get_court", {"court": "pool-balboa"}, "b")]),
            llm.Reply(text="Here's the comparison."),
        )
        assert [s.tool for s in result.steps] == ["get_court", "get_court"]
        assert result.stopped_because == "answered"


# ---------------------------------------------------------------------------
# State injection
# ---------------------------------------------------------------------------


class TestStateInjection:
    def test_the_active_city_is_filled_in_when_the_model_omits_it(self):
        # A user in New York must not get San Francisco by falling through to
        # retrieval's default.
        result, _ = ask(
            "any basketball?",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball"})]),
            llm.Reply(text="Yes."),
            state={"city": "nyc"},
        )
        assert result.steps[0].arguments["city"] == "nyc"

    def test_an_explicit_city_from_the_model_wins(self):
        # "What about San Francisco?" asked from New York.
        result, _ = ask(
            "what about SF?",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball", "city": "sf"})]),
            llm.Reply(text="Yes."),
            state={"city": "nyc"},
        )
        assert result.steps[0].arguments["city"] == "sf"

    def test_city_is_not_injected_into_tools_that_take_none(self):
        result, _ = ask(
            "how do I book?",
            llm.Reply(tool_calls=[call("get_reservation_policy", {"court": "alice-marble-tennis-courts-outdoor"})]),
            llm.Reply(text="Seven days ahead."),
        )
        # get_reservation_policy does accept city, so assert on a tool that
        # genuinely lacks it by checking the schema drives the decision.
        assert ("city" in result.steps[0].arguments) == (
            "city" in tools.SCHEMAS["get_reservation_policy"]["properties"]
        )

    def test_coordinates_produce_distances(self):
        result, _ = ask(
            "closest court?",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball", "when": "2026-07-25T10:00"})]),
            llm.Reply(text="Jose Coronado, 0.2 miles."),
            state={"city": "sf", "lat": 37.7599, "lng": -122.4148},
            debug=True,
        )
        assert all("miles_from_user" in c for c in result.steps[0].result["courts"])

    def test_missing_coordinates_are_simply_absent(self):
        result, _ = ask(
            "any courts?",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball", "when": "2026-07-25T10:00"})]),
            llm.Reply(text="Yes."),
            state={"city": "sf"},
            debug=True,
        )
        assert "miles_from_user" not in result.steps[0].result["courts"][0]

    def test_the_model_can_never_supply_coordinates(self):
        # `origin` is keyword-only on the tools and unadvertised in the schemas,
        # so a model that invents lat/lng has them dropped as unknown arguments.
        result, _ = ask(
            "near me?",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball", "lat": 1.0, "lng": 2.0})]),
            llm.Reply(text="Here you go."),
            debug=True,
        )
        assert "lat" not in result.steps[0].arguments
        assert "miles_from_user" not in result.steps[0].result["courts"][0]

    def test_an_unknown_city_in_state_falls_back_to_the_default(self):
        result, _ = ask(
            "any basketball?",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball"})]),
            llm.Reply(text="Yes."),
            state={"city": "atlantis"},
        )
        assert result.steps[0].arguments["city"] == "sf"


class TestContextInjection:
    def test_the_time_and_city_ride_in_the_user_turn(self):
        _, provider = ask("what's open?", llm.Reply(text="Plenty."))
        user_message = provider.calls[0]["messages"][-1]
        assert user_message["role"] == "user"
        assert "Local time is" in user_message["content"]
        assert "San Francisco" in user_message["content"]

    def test_the_system_prompt_stays_byte_identical(self):
        # It's the cached prefix. Anything volatile in it would re-bill ~8KB of
        # tool schemas on every question.
        _, first = ask("q1", llm.Reply(text="a"))
        _, second = ask("q2", llm.Reply(text="b"))
        assert first.calls[0]["system"] == second.calls[0]["system"] == agent.SYSTEM_PROMPT

    def test_no_clock_or_city_leaks_into_the_system_prompt(self):
        for token in ("Local time", "2026", ":00"):
            assert token not in agent.SYSTEM_PROMPT

    def test_the_original_question_survives_the_annotation(self):
        _, provider = ask("is Rossi open?", llm.Reply(text="Yes."))
        assert "is Rossi open?" in provider.calls[0]["messages"][-1]["content"]

    def test_context_is_added_even_with_no_user_turn(self):
        provider = ScriptedProvider(llm.Reply(text="hi"))
        agent.answer([], {"city": "sf"}, provider=provider)
        assert "Local time is" in provider.calls[0]["messages"][-1]["content"]


# ---------------------------------------------------------------------------
# Failure handling
# ---------------------------------------------------------------------------


class TestToolFailures:
    def test_a_bad_argument_comes_back_as_a_readable_error(self):
        result, provider = ask(
            "any cricket?",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "cricket"})]),
            llm.Reply(text="No cricket, but there's tennis."),
        )
        assert result.steps[0].ok is False
        error_message = provider.calls[1]["messages"][-1]
        assert error_message["is_error"] is True
        assert "basketball" in error_message["content"]  # names the valid values
        assert result.reply == "No cricket, but there's tennis."

    def test_an_unknown_tool_name_is_survivable(self):
        result, _ = ask(
            "?",
            llm.Reply(tool_calls=[call("find_pizza", {})]),
            llm.Reply(text="I can't do that."),
        )
        assert result.steps[0].ok is False
        assert "find_pizza" in result.steps[0].error

    def test_an_unexpected_exception_does_not_kill_the_turn(self, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("retrieval is broken")

        monkeypatch.setattr(tools, "call", boom)
        result, _ = ask(
            "any basketball?",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball"})]),
            llm.Reply(text="I couldn't check just now."),
        )
        assert result.steps[0].ok is False
        assert "RuntimeError" in result.steps[0].error
        assert result.reply == "I couldn't check just now."

    def test_the_loop_continues_after_a_failed_call(self):
        result, _ = ask(
            "any cricket? ok then tennis",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "cricket"}, "a")]),
            llm.Reply(tool_calls=[call("find_courts", {"sport": "tennis"}, "b")]),
            llm.Reply(text="Tennis it is."),
        )
        assert [s.ok for s in result.steps] == [False, True]


class TestGuardrails:
    def test_the_step_ceiling_forces_a_final_answer(self, monkeypatch):
        monkeypatch.setattr(config, "MAX_STEPS", 3)
        # A model that only ever asks for tools, with varying args so the
        # duplicate guard doesn't catch it first.
        replies = [
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball", "limit": n}, f"c{n}")])
            for n in range(1, 4)  # exactly MAX_STEPS
        ]
        provider = ScriptedProvider(*replies, llm.Reply(text="Forced summary."))
        result = agent.answer([{"role": "user", "content": "loop forever"}], {"city": "sf"},
                              provider=provider)
        assert result.stopped_because == "step_limit"
        assert len(result.steps) == 3
        assert result.reply == "Forced summary."

    def test_the_forced_turn_offers_no_tools(self, monkeypatch):
        monkeypatch.setattr(config, "MAX_STEPS", 1)
        provider = ScriptedProvider(
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball"})]),
            llm.Reply(text="Summary."),
        )
        agent.answer([{"role": "user", "content": "q"}], {"city": "sf"}, provider=provider)
        assert provider.calls[0]["tools"] is not None
        assert provider.calls[-1]["tools"] is None, "the last turn must make prose the only option"

    def test_an_identical_repeated_call_is_not_rerun(self):
        arguments = {"sport": "basketball", "city": "sf"}
        result, provider = ask(
            "stuck",
            llm.Reply(tool_calls=[call("find_courts", arguments, "a")]),
            llm.Reply(tool_calls=[call("find_courts", arguments, "b")]),
            llm.Reply(text="Right, here's the answer."),
        )
        assert [s.ok for s in result.steps] == [True, False]
        assert result.steps[1].error == "duplicate call"
        assert "Answer the user" in provider.calls[2]["messages"][-1]["content"]

    def test_the_same_tool_with_different_arguments_is_allowed(self):
        result, _ = ask(
            "two sports",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "tennis"}, "a")]),
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball"}, "b")]),
            llm.Reply(text="Both available."),
        )
        assert all(s.ok for s in result.steps)

    def test_an_empty_reply_becomes_an_apology(self):
        result, _ = ask("q", llm.Reply(text=""))
        assert result.reply == agent._EMPTY_REPLY
        assert result.stopped_because == "empty_reply"

    def test_an_oversized_result_is_truncated(self, monkeypatch):
        monkeypatch.setattr(agent, "MAX_RESULT_CHARS", 50)
        result, provider = ask(
            "everything",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball", "limit": 25})]),
            llm.Reply(text="Lots."),
        )
        assert result.steps[0].result_chars <= 80
        assert "truncated" in provider.calls[1]["messages"][-1]["content"]


# ---------------------------------------------------------------------------
# Output shape
# ---------------------------------------------------------------------------


class TestAnswerShape:
    def test_the_plain_payload_is_small_and_carries_no_internals(self):
        result, _ = ask(
            "any basketball?",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball"})]),
            llm.Reply(text="Yes."),
        )
        payload = result.to_dict()
        assert payload["reply"] == "Yes."
        assert payload["tools_used"] == ["find_courts"]
        assert "steps" not in payload
        assert "usage" not in payload

    def test_debug_adds_the_audit_trail(self):
        result, _ = ask(
            "any basketball?",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball"})]),
            llm.Reply(text="Yes."),
            debug=True,
        )
        payload = result.to_dict(debug=True)
        assert payload["steps"][0]["tool"] == "find_courts"
        assert payload["steps"][0]["arguments"]["city"] == "sf"
        assert payload["steps"][0]["result"]["sport"] == "basketball"
        assert "usage" in payload

    def test_results_are_withheld_unless_debugging(self):
        result, _ = ask(
            "any basketball?",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball"})]),
            llm.Reply(text="Yes."),
        )
        assert result.steps[0].result is None

    def test_usage_accumulates_across_turns(self):
        result, _ = ask(
            "q",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball"})],
                      usage={"input_tokens": 100, "output_tokens": 10}),
            llm.Reply(text="Yes.", usage={"input_tokens": 300, "output_tokens": 20}),
        )
        assert result.usage == {"input_tokens": 400, "output_tokens": 30}

    def test_the_payload_is_json_serializable(self):
        result, _ = ask(
            "q",
            llm.Reply(tool_calls=[call("find_courts", {"sport": "basketball"})]),
            llm.Reply(text="Yes."),
            debug=True,
        )
        json.dumps(result.to_dict(debug=True))

    def test_the_provider_is_reported(self):
        result, _ = ask("q", llm.Reply(text="hi"))
        assert result.provider == "scripted"
        assert result.model == "scripted-1"


# ---------------------------------------------------------------------------
# The system prompt itself
# ---------------------------------------------------------------------------


class TestSystemPrompt:
    def test_it_forbids_inventing_facts(self):
        assert "must not" in agent.SYSTEM_PROMPT
        assert "Never add a detail nobody gave you" in agent.SYSTEM_PROMPT

    def test_it_explains_matched_versus_shown(self):
        # Otherwise a truncated list gets reported as the whole truth.
        assert "matched" in agent.SYSTEM_PROMPT and "shown" in agent.SYSTEM_PROMPT

    def test_it_covers_restrictions(self):
        assert "restriction" in agent.SYSTEM_PROMPT
        assert "women only" in agent.SYSTEM_PROMPT

    def test_it_asks_for_the_users_language(self):
        assert "language the user wrote in" in agent.SYSTEM_PROMPT

    def test_it_carries_the_app_how_to_knowledge(self):
        # The "how do I use RECreate?" answers live here rather than in a tool.
        assert agent.APP_FACTS in agent.SYSTEM_PROMPT
        assert "Favorites" in agent.APP_FACTS
        assert "Pool data is San" in agent.APP_FACTS  # SF-only, wrapped across lines

    def test_it_stays_a_reasonable_size(self):
        # Rides on every request alongside ~8KB of tool schemas.
        assert len(agent.SYSTEM_PROMPT) < 6000


# ---------------------------------------------------------------------------
# Leaked tool calls
# ---------------------------------------------------------------------------


class TestLeakedToolCall:
    """A small model sometimes writes a tool call as its visible reply.

    The turn "succeeds", nothing runs, and the user sees raw JSON. No prompt rule
    stops it — the model thinks it called the tool — so the loop catches it.
    """

    @pytest.mark.parametrize(
        "text",
        [
            '{"name": "find_classes", "parameters": {"free_only": true}}',
            '{"name": "find_courts", "arguments": {"sport": "tennis"}}',
            '{"name": "find_courts", "parameters": {"sport": "ten',  # truncated
        ],
    )
    def test_detected(self, text):
        assert agent._looks_like_a_leaked_tool_call(text)

    @pytest.mark.parametrize(
        "text",
        [
            "Mission Rec is open until 5PM.",
            "",
            '{"this": "is just json"}',
            "Rossi is open 8AM-9AM, 9AM-5PM (open play), and 5PM-8PM.",
        ],
    )
    def test_real_answers_are_not_flagged(self, text):
        assert not agent._looks_like_a_leaked_tool_call(text)

    def test_a_long_reply_that_merely_starts_with_a_brace_is_not_flagged(self):
        assert not agent._looks_like_a_leaked_tool_call("{" + "x" * 700)

    def test_the_loop_retries_instead_of_showing_json(self):
        result, provider = ask(
            "any free swim classes?",
            llm.Reply(text='{"name": "find_classes", "parameters": {"free_only": true}}'),
            llm.Reply(tool_calls=[call("find_classes", {"free_only": True})]),
            llm.Reply(text="Yes — Bayview Safety Swim & Splash is free."),
        )
        assert result.reply == "Yes — Bayview Safety Swim & Splash is free."
        assert "{" not in result.reply
        assert result.steps[0].tool == "(leaked tool call)"
        # The correction is fed back so the model knows what went wrong.
        assert "not a tool call" in provider.calls[1]["messages"][-1]["content"]

    @pytest.mark.parametrize(
        "text",
        [
            # Every leak seen in practice had a preamble. The first version of
            # the guard anchored at the start of the string and passed these
            # through to the user as answers.
            'To find pickleball courts, we\'ll use the `find_courts` function with the '
            'following arguments:  {"name": "find_courts", "parameters": {"sport": "pickleball"}}',
            'That doesn\'t seem right. Let me call the tool again:\n'
            '{"name": "find_courts", "parameters": {"city": "nyc", "sport": "swimming"}}',
        ],
    )
    def test_a_leak_with_a_preamble_is_caught(self, text):
        assert agent._looks_like_a_leaked_tool_call(text)

    def test_the_user_never_sees_json_even_on_the_final_turn(self):
        # No tools are offered on the forced final turn, but a model that has
        # decided it needs one will write the call out by hand anyway.
        leak = ('To answer that we\'ll use the `find_courts` function with these arguments: '
                '{"name": "find_courts", "parameters": {"sport": "tennis"}}')
        result, _ = ask(
            "where can I play tennis?",
            *([llm.Reply(tool_calls=[call("find_courts", {"sport": "tennis"})])] * config.MAX_STEPS),
            llm.Reply(text=leak),
        )
        assert "{" not in result.reply
        assert "find_courts" not in result.reply
        assert result.stopped_because == "leaked_tool_call"

    def test_scrubbing_keeps_a_real_answer_that_trails_a_leak(self):
        text = ('{"name": "find_courts", "parameters": {"sport": "tennis"}} '
                "Alice Marble Tennis Courts at 1200 Greenwich St has four courts and a "
                "hitting wall, and it is open until 8PM tonight.")
        kept = agent._strip_leaked_call(text)
        assert "Alice Marble" in kept
        assert "{" not in kept
