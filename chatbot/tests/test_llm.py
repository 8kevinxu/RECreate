"""Tests for the provider seam.

No network and no model. What's tested is the part that actually breaks: the
translation between the neutral message shape and each provider's wire format,
and the error paths. Both providers are exercised against fakes, so a bug in the
Anthropic block layout is caught without an API key.
"""

import json
from types import SimpleNamespace

import pytest

import config
import llm
import tools as tool_schemas


# ---------------------------------------------------------------------------
# Neutral types
# ---------------------------------------------------------------------------


class TestReply:
    def test_a_reply_with_calls_wants_tools(self):
        reply = llm.Reply(tool_calls=[llm.ToolCall(id="a", name="find_courts", arguments={})])
        assert reply.wants_tools

    def test_a_plain_answer_does_not(self):
        assert not llm.Reply(text="Yes, three courts are open.").wants_tools


# ---------------------------------------------------------------------------
# Anthropic translation
# ---------------------------------------------------------------------------


class TestAnthropicWireFormat:
    def test_a_user_turn_is_plain_text(self):
        wire = llm.AnthropicProvider._to_wire([{"role": "user", "content": "hi"}])
        assert wire == [{"role": "user", "content": "hi"}]

    def test_assistant_tool_calls_become_tool_use_blocks(self):
        wire = llm.AnthropicProvider._to_wire(
            [
                {"role": "user", "content": "any tennis?"},
                {
                    "role": "assistant",
                    "content": "Let me look.",
                    "tool_calls": [llm.ToolCall(id="tu_1", name="find_courts", arguments={"sport": "tennis"})],
                },
            ]
        )
        blocks = wire[1]["content"]
        assert blocks[0] == {"type": "text", "text": "Let me look."}
        assert blocks[1] == {
            "type": "tool_use",
            "id": "tu_1",
            "name": "find_courts",
            "input": {"sport": "tennis"},
        }

    def test_a_tool_result_rides_in_a_user_message(self):
        # Counterintuitive but required: results are USER content, not tool role.
        wire = llm.AnthropicProvider._to_wire(
            [{"role": "tool", "tool_call_id": "tu_1", "name": "find_courts", "content": "{}"}]
        )
        assert wire[0]["role"] == "user"
        assert wire[0]["content"][0]["type"] == "tool_result"
        assert wire[0]["content"][0]["tool_use_id"] == "tu_1"

    def test_parallel_results_are_batched_into_one_message(self):
        # The regression this batching exists for: splitting results across
        # messages trains the model to stop making parallel calls.
        wire = llm.AnthropicProvider._to_wire(
            [
                {"role": "user", "content": "pool hours and price?"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        llm.ToolCall(id="a", name="get_pool_info", arguments={"topic": "schedule"}),
                        llm.ToolCall(id="b", name="get_pool_info", arguments={"topic": "fees"}),
                    ],
                },
                {"role": "tool", "tool_call_id": "a", "name": "get_pool_info", "content": "{}"},
                {"role": "tool", "tool_call_id": "b", "name": "get_pool_info", "content": "{}"},
            ]
        )
        assert len(wire) == 3, "two tool results should collapse into one user message"
        assert [b["tool_use_id"] for b in wire[2]["content"]] == ["a", "b"]

    def test_an_error_result_is_flagged(self):
        wire = llm.AnthropicProvider._to_wire(
            [{"role": "tool", "tool_call_id": "x", "name": "f", "content": "boom", "is_error": True}]
        )
        assert wire[0]["content"][0]["is_error"] is True

    def test_a_successful_result_carries_no_error_flag(self):
        wire = llm.AnthropicProvider._to_wire(
            [{"role": "tool", "tool_call_id": "x", "name": "f", "content": "{}"}]
        )
        assert "is_error" not in wire[0]["content"][0]

    def test_an_empty_assistant_turn_is_dropped(self):
        # An assistant turn with neither text nor calls would be a 400.
        wire = llm.AnthropicProvider._to_wire(
            [{"role": "user", "content": "hi"}, {"role": "assistant", "content": ""}]
        )
        assert len(wire) == 1

    def test_results_stay_after_the_assistant_turn_that_asked(self):
        wire = llm.AnthropicProvider._to_wire(
            [
                {"role": "user", "content": "q"},
                {"role": "assistant", "content": "", "tool_calls": [llm.ToolCall("a", "f", {})]},
                {"role": "tool", "tool_call_id": "a", "name": "f", "content": "{}"},
                {"role": "assistant", "content": "the answer"},
            ]
        )
        assert [m["role"] for m in wire] == ["user", "assistant", "user", "assistant"]


# ---------------------------------------------------------------------------
# Anthropic response parsing, against a fake SDK
# ---------------------------------------------------------------------------


def _fake_anthropic(response):
    """A stand-in for the SDK: records the request, returns a canned response."""
    captured = {}

    class FakeMessages:
        def create(self, **kwargs):
            captured.update(kwargs)
            return response

    class FakeError(Exception):
        pass

    module = SimpleNamespace(
        Anthropic=lambda **_: SimpleNamespace(beta=SimpleNamespace(messages=FakeMessages())),
        AuthenticationError=type("AuthenticationError", (FakeError,), {}),
        RateLimitError=type("RateLimitError", (FakeError,), {}),
        APIStatusError=type("APIStatusError", (FakeError,), {}),
        APIConnectionError=type("APIConnectionError", (FakeError,), {}),
    )
    return module, captured


@pytest.fixture
def anthropic_provider(monkeypatch):
    """Build an AnthropicProvider wired to a fake SDK. Returns (make, captured)."""
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "sk-test")

    def make(response):
        module, captured = _fake_anthropic(response)
        provider = llm.AnthropicProvider.__new__(llm.AnthropicProvider)
        provider._sdk = module
        provider._client = module.Anthropic()
        provider.model = "claude-opus-5"
        return provider, captured

    return make


def _block(kind, **fields):
    return SimpleNamespace(type=kind, **fields)


def _response(content, stop_reason="end_turn", usage=None):
    return SimpleNamespace(
        content=content,
        stop_reason=stop_reason,
        usage=usage
        or SimpleNamespace(
            input_tokens=100, output_tokens=20, cache_read_input_tokens=2000,
            cache_creation_input_tokens=0,
        ),
    )


class TestAnthropicCall:
    def test_parses_a_text_answer(self, anthropic_provider):
        provider, _ = anthropic_provider(_response([_block("text", text="Three courts are open.")]))
        reply = provider.chat("sys", [{"role": "user", "content": "q"}], None)
        assert reply.text == "Three courts are open."
        assert not reply.wants_tools

    def test_parses_tool_calls(self, anthropic_provider):
        provider, _ = anthropic_provider(
            _response(
                [
                    _block("text", text="Checking."),
                    _block("tool_use", id="tu_9", name="find_courts", input={"sport": "tennis"}),
                ],
                stop_reason="tool_use",
            )
        )
        reply = provider.chat("sys", [{"role": "user", "content": "q"}], None)
        assert reply.text == "Checking."
        assert reply.tool_calls[0].id == "tu_9"
        assert reply.tool_calls[0].arguments == {"sport": "tennis"}

    def test_a_refusal_is_handled_without_reading_content(self, anthropic_provider):
        # A refusal returns HTTP 200 with possibly EMPTY content — indexing
        # content[0] here would raise.
        provider, _ = anthropic_provider(_response([], stop_reason="refusal"))
        reply = provider.chat("sys", [{"role": "user", "content": "q"}], None)
        assert reply.stop_reason == "refusal"
        assert reply.text
        assert not reply.wants_tools

    def test_the_system_prompt_is_sent_as_a_cached_block(self, anthropic_provider):
        provider, captured = anthropic_provider(_response([_block("text", text="ok")]))
        provider.chat("SYSTEM TEXT", [{"role": "user", "content": "q"}], None)
        system = captured["system"]
        assert system[0]["text"] == "SYSTEM TEXT"
        assert system[0]["cache_control"] == {"type": "ephemeral"}

    def test_no_sampling_parameters_are_sent(self, anthropic_provider):
        # temperature / top_p / top_k are rejected on current models.
        provider, captured = anthropic_provider(_response([_block("text", text="ok")]))
        provider.chat("sys", [{"role": "user", "content": "q"}], None)
        assert not {"temperature", "top_p", "top_k"} & captured.keys()

    def test_effort_and_fallbacks_are_configured(self, anthropic_provider):
        provider, captured = anthropic_provider(_response([_block("text", text="ok")]))
        provider.chat("sys", [{"role": "user", "content": "q"}], None)
        assert captured["output_config"]["effort"] == config.ANTHROPIC_EFFORT
        assert captured["fallbacks"] == "default"

    def test_tools_are_omitted_when_none_are_given(self, anthropic_provider):
        provider, captured = anthropic_provider(_response([_block("text", text="ok")]))
        provider.chat("sys", [{"role": "user", "content": "q"}], None)
        assert "tools" not in captured

    def test_usage_surfaces_cache_reads(self, anthropic_provider):
        provider, _ = anthropic_provider(_response([_block("text", text="ok")]))
        reply = provider.chat("sys", [{"role": "user", "content": "q"}], None)
        assert reply.usage["cache_read_input_tokens"] == 2000

    @pytest.mark.parametrize(
        "error_name,expected",
        [("AuthenticationError", "API key"), ("RateLimitError", "Rate limited"),
         ("APIConnectionError", "Could not reach")],
    )
    def test_sdk_errors_become_readable_llm_errors(self, anthropic_provider, error_name, expected):
        provider, _ = anthropic_provider(_response([]))

        def boom(**_):
            raise getattr(provider._sdk, error_name)("raw")

        provider._client.beta.messages.create = boom
        with pytest.raises(llm.LLMError, match=expected):
            provider.chat("sys", [{"role": "user", "content": "q"}], None)

    def test_a_missing_key_fails_with_instructions(self, monkeypatch):
        monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "")
        with pytest.raises(llm.LLMError, match="ANTHROPIC_API_KEY"):
            llm.AnthropicProvider()


# ---------------------------------------------------------------------------
# Ollama
# ---------------------------------------------------------------------------


class TestOllamaWireFormat:
    def test_the_system_prompt_becomes_a_message(self):
        wire = llm.OllamaProvider._to_wire("sys", [{"role": "user", "content": "hi"}])
        assert wire[0] == {"role": "system", "content": "sys"}
        assert wire[1] == {"role": "user", "content": "hi"}

    def test_tool_calls_use_the_function_envelope(self):
        wire = llm.OllamaProvider._to_wire(
            "sys",
            [
                {"role": "user", "content": "q"},
                {"role": "assistant", "content": "", "tool_calls": [llm.ToolCall("x", "find_courts", {"sport": "tennis"})]},
            ],
        )
        assert wire[-1]["tool_calls"] == [
            {"function": {"name": "find_courts", "arguments": {"sport": "tennis"}}}
        ]

    def test_results_are_separate_tool_messages(self):
        # Unlike Anthropic, Ollama takes one message per result.
        wire = llm.OllamaProvider._to_wire(
            "sys",
            [
                {"role": "tool", "tool_call_id": "a", "name": "f", "content": "{}"},
                {"role": "tool", "tool_call_id": "b", "name": "g", "content": "{}"},
            ],
        )
        assert [m["role"] for m in wire[1:]] == ["tool", "tool"]


class TestOllamaCall:
    def _provider(self, monkeypatch, body):
        provider = llm.OllamaProvider()
        monkeypatch.setattr(
            llm.httpx,
            "post",
            lambda *a, **k: SimpleNamespace(raise_for_status=lambda: None, json=lambda: body),
        )
        return provider

    def test_parses_a_text_answer(self, monkeypatch):
        provider = self._provider(monkeypatch, {"message": {"content": "Open until 8PM."}})
        reply = provider.chat("sys", [{"role": "user", "content": "q"}], None)
        assert reply.text == "Open until 8PM."

    def test_mints_ids_for_tool_calls(self, monkeypatch):
        # Ollama supplies no call ids, so results could not otherwise be matched.
        provider = self._provider(
            monkeypatch,
            {"message": {"content": "", "tool_calls": [{"function": {"name": "find_courts", "arguments": {"sport": "tennis"}}}]}},
        )
        reply = provider.chat("sys", [{"role": "user", "content": "q"}], None)
        assert reply.tool_calls[0].id
        assert reply.tool_calls[0].name == "find_courts"

    def test_ids_are_unique_across_parallel_calls(self, monkeypatch):
        provider = self._provider(
            monkeypatch,
            {"message": {"tool_calls": [
                {"function": {"name": "a", "arguments": {}}},
                {"function": {"name": "b", "arguments": {}}},
            ]}},
        )
        reply = provider.chat("sys", [{"role": "user", "content": "q"}], None)
        assert reply.tool_calls[0].id != reply.tool_calls[1].id

    def test_arguments_arriving_as_a_json_string_are_parsed(self, monkeypatch):
        # Some builds stringify the arguments.
        provider = self._provider(
            monkeypatch,
            {"message": {"tool_calls": [{"function": {"name": "find_courts", "arguments": json.dumps({"sport": "tennis"})}}]}},
        )
        reply = provider.chat("sys", [{"role": "user", "content": "q"}], None)
        assert reply.tool_calls[0].arguments == {"sport": "tennis"}

    def test_unparseable_arguments_degrade_to_empty(self, monkeypatch):
        provider = self._provider(
            monkeypatch, {"message": {"tool_calls": [{"function": {"name": "f", "arguments": "not json"}}]}}
        )
        assert provider.chat("sys", [{"role": "user", "content": "q"}], None).tool_calls[0].arguments == {}

    def test_a_connection_error_says_how_to_start_ollama(self, monkeypatch):
        provider = llm.OllamaProvider()

        def boom(*a, **k):
            raise llm.httpx.ConnectError("refused")

        monkeypatch.setattr(llm.httpx, "post", boom)
        with pytest.raises(llm.LLMError, match="ollama serve"):
            provider.chat("sys", [{"role": "user", "content": "q"}], None)


# ---------------------------------------------------------------------------
# Selection and tool payloads
# ---------------------------------------------------------------------------


class TestProviderSelection:
    def test_unknown_provider_lists_the_real_ones(self):
        with pytest.raises(llm.LLMError, match="ollama"):
            llm.get_provider("chatgpt")

    def test_providers_are_cached(self):
        assert llm.get_provider("ollama") is llm.get_provider("ollama")

    def test_each_provider_gets_its_own_tool_envelope(self):
        ollama = llm.get_provider("ollama")
        payload = llm.tool_payload(ollama)
        assert payload == tool_schemas.for_openai()
        assert payload[0]["type"] == "function"

    def test_both_envelopes_advertise_the_same_tools(self):
        openai_names = {t["function"]["name"] for t in tool_schemas.for_openai()}
        anthropic_names = {t["name"] for t in tool_schemas.for_anthropic()}
        assert openai_names == anthropic_names == set(tool_schemas.names())

    def test_both_providers_satisfy_the_protocol(self):
        for provider_cls in (llm.AnthropicProvider, llm.OllamaProvider):
            for method in ("chat", "health", "name"):
                assert hasattr(provider_cls, method)


class TestOllamaHealth:
    def test_health_never_raises_when_ollama_is_down(self, monkeypatch):
        def boom(*a, **k):
            raise llm.httpx.ConnectError("refused")

        monkeypatch.setattr(llm.httpx, "get", boom)
        health = llm.OllamaProvider().health()
        assert health["reachable"] is False
        assert "error" in health


def test_config_summary_never_leaks_the_key(monkeypatch):
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "sk-secret-value")
    assert "sk-secret-value" not in json.dumps(config.summary())
    assert config.summary()["has_anthropic_key"] is True
