"""The provider seam: one `chat()` interface over Anthropic and Ollama.

Everything above this file — agent.py, app.py — is written against `Reply` and
`ToolCall` and cannot tell which provider is running. Everything below is wire
format, and the two wire formats disagree about almost everything:

                        Anthropic                    Ollama (OpenAI-shaped)
    system prompt       top-level `system` param     a message with role=system
    tool schema         {name, description,          {type: "function",
                         input_schema}                function: {...}}
    a tool call         a `tool_use` content block   message.tool_calls[].function
    call identity       server-assigned `id`         no id at all — we mint one
    a tool result       `tool_result` block, in a    a message with role=tool,
                        USER message                 one per result
    parallel calls      all results in ONE user      separate messages
                        message

So this module defines a neutral message shape, and each provider translates in
and out of it. The neutral shape is deliberately not either provider's — copying
Anthropic's blocks as the internal format would quietly make Ollama the
second-class citizen and leak `input_schema` into files that shouldn't know it.

Neutral messages (what agent.py builds):

    {"role": "user",      "content": "any pickleball open saturday?"}
    {"role": "assistant", "content": "...", "tool_calls": [ToolCall, ...]}
    {"role": "tool",      "tool_call_id": "...", "name": "find_courts",
                          "content": "<json>", "is_error": False}

One rule that is easy to get wrong and has no visible symptom: when a model asks
for several tools at once, **every result must go back in a single turn**.
Splitting them teaches the model to stop making parallel calls at all. The
Anthropic translation below batches consecutive tool messages into one user
message for exactly that reason.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

import config
import tools as tool_schemas


class LLMError(RuntimeError):
    """A provider failed in a way worth showing the user (down, unauthorized, …)."""


@dataclass
class ToolCall:
    """A model's request to run one tool. `id` correlates it with its result."""

    id: str
    name: str
    arguments: dict


@dataclass
class Reply:
    """One model turn, provider-independent.

    `tool_calls` non-empty means the model wants tools run and is not finished.
    `text` may be present alongside them — models often narrate before calling.
    """

    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    stop_reason: str = ""
    usage: dict = field(default_factory=dict)

    @property
    def wants_tools(self) -> bool:
        return bool(self.tool_calls)


class Provider(Protocol):
    name: str
    model: str

    def chat(self, system: str, messages: list[dict], tools: list[dict] | None) -> Reply: ...

    def health(self) -> dict: ...


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------


class AnthropicProvider:
    """Claude via the official SDK.

    Three things here are deliberate rather than incidental:

    **The system prompt is cached.** Tools and system render ahead of the
    conversation, so a `cache_control` breakpoint on the system block covers both
    — roughly 8KB of tool schemas plus instructions that would otherwise be
    re-read at full price on every single question. This only works because the
    prefix is byte-identical each time, which is why the current time is NOT in
    the system prompt (agent.py puts it in the user turn). One `datetime.now()`
    up there would silently disable caching forever.

    **Refusals are checked before content is read.** A declined request returns
    HTTP 200 with `stop_reason: "refusal"` and possibly empty content, so code
    that reaches for `content[0]` breaks. `fallbacks="default"` asks the API to
    re-run a refused request on a fallback model server-side, which turns most
    refusals into an answer instead of an error.

    **No temperature/top_p.** Those are rejected on current models; steer with
    the prompt instead.
    """

    name = "anthropic"

    def __init__(self) -> None:
        try:
            import anthropic
        except ImportError as exc:  # pragma: no cover - dependency is in requirements
            raise LLMError("The `anthropic` package is not installed: pip install anthropic") from exc
        if not config.ANTHROPIC_API_KEY:
            raise LLMError(
                "ASSISTANT_PROVIDER=anthropic needs ANTHROPIC_API_KEY set in chatbot/.env "
                "(it stays server-side and never reaches the app)."
            )
        self._sdk = anthropic
        self._client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY, timeout=config.TIMEOUT)
        self.model = config.ANTHROPIC_MODEL

    # -- translation ------------------------------------------------------

    @staticmethod
    def _to_wire(messages: list[dict]) -> list[dict]:
        """Neutral messages -> Anthropic content blocks.

        Consecutive `tool` messages collapse into one user message so parallel
        tool results arrive together, as the API expects.
        """
        wire: list[dict] = []
        pending_results: list[dict] = []

        def flush() -> None:
            if pending_results:
                wire.append({"role": "user", "content": list(pending_results)})
                pending_results.clear()

        for message in messages:
            role = message["role"]
            if role == "tool":
                pending_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": message["tool_call_id"],
                        "content": message["content"],
                        **({"is_error": True} if message.get("is_error") else {}),
                    }
                )
                continue

            flush()
            if role == "assistant":
                blocks: list[dict] = []
                if message.get("content"):
                    blocks.append({"type": "text", "text": message["content"]})
                for call in message.get("tool_calls") or []:
                    blocks.append(
                        {"type": "tool_use", "id": call.id, "name": call.name, "input": call.arguments}
                    )
                if blocks:
                    wire.append({"role": "assistant", "content": blocks})
            else:
                wire.append({"role": "user", "content": message["content"]})

        flush()
        return wire

    # -- the call ---------------------------------------------------------

    def chat(self, system: str, messages: list[dict], tools: list[dict] | None = None) -> Reply:
        request: dict[str, Any] = {
            "model": self.model,
            "max_tokens": config.MAX_TOKENS,
            # A list with cache_control, not a bare string — this is the cache
            # breakpoint, and it covers the tool schemas rendered ahead of it.
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "messages": self._to_wire(messages),
            "output_config": {"effort": config.ANTHROPIC_EFFORT},
            # Server-side recovery from a policy refusal, routed by category.
            "betas": ["server-side-fallback-2026-07-01"],
            "fallbacks": "default",
        }
        if tools:
            request["tools"] = tools

        try:
            response = self._client.beta.messages.create(**request)
        except self._sdk.AuthenticationError as exc:
            raise LLMError("Anthropic rejected the API key.") from exc
        except self._sdk.RateLimitError as exc:
            raise LLMError("Rate limited by Anthropic — try again in a moment.") from exc
        except self._sdk.APIStatusError as exc:
            raise LLMError(f"Anthropic error {exc.status_code}: {exc.message}") from exc
        except self._sdk.APIConnectionError as exc:
            raise LLMError("Could not reach Anthropic — check the network.") from exc

        # Check the stop reason BEFORE touching content: a refusal can be empty.
        if response.stop_reason == "refusal":
            return Reply(
                text="I can't help with that one.",
                stop_reason="refusal",
                usage=self._usage(response),
            )

        text_parts: list[str] = []
        calls: list[ToolCall] = []
        for block in response.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                calls.append(ToolCall(id=block.id, name=block.name, arguments=dict(block.input or {})))

        return Reply(
            text="\n".join(p for p in text_parts if p).strip(),
            tool_calls=calls,
            stop_reason=response.stop_reason or "",
            usage=self._usage(response),
        )

    @staticmethod
    def _usage(response: Any) -> dict:
        usage = getattr(response, "usage", None)
        if not usage:
            return {}
        return {
            "input_tokens": getattr(usage, "input_tokens", None),
            "output_tokens": getattr(usage, "output_tokens", None),
            # Zero cache reads across repeated questions means the prefix is
            # being invalidated — something volatile crept into system or tools.
            "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", None),
            "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", None),
        }

    def health(self) -> dict:
        return {"provider": self.name, "model": self.model, "reachable": bool(config.ANTHROPIC_API_KEY)}


# ---------------------------------------------------------------------------
# Ollama
# ---------------------------------------------------------------------------


class OllamaProvider:
    """A local model over Ollama's /api/chat, spoken in plain HTTP.

    No official Python client exists, so this is httpx against a documented
    JSON endpoint — the honest choice here, where the Anthropic path uses the
    official SDK because there is one.

    Ollama's tool-call objects carry **no id**, so ids are minted locally to
    correlate calls with results. Small models are also erratic at tool calling
    generally; that's the trade for running free and offline.
    """

    name = "ollama"

    def __init__(self) -> None:
        self.model = config.OLLAMA_MODEL
        self._url = config.OLLAMA_URL.rstrip("/")

    @staticmethod
    def _to_wire(system: str, messages: list[dict]) -> list[dict]:
        """Neutral messages -> OpenAI-shaped messages (system becomes a message)."""
        wire: list[dict] = [{"role": "system", "content": system}]
        for message in messages:
            role = message["role"]
            if role == "tool":
                wire.append(
                    {"role": "tool", "content": message["content"], "tool_name": message.get("name", "")}
                )
            elif role == "assistant":
                entry: dict[str, Any] = {"role": "assistant", "content": message.get("content") or ""}
                if message.get("tool_calls"):
                    entry["tool_calls"] = [
                        {"function": {"name": c.name, "arguments": c.arguments}}
                        for c in message["tool_calls"]
                    ]
                wire.append(entry)
            else:
                wire.append({"role": "user", "content": message["content"]})
        return wire

    def chat(self, system: str, messages: list[dict], tools: list[dict] | None = None) -> Reply:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": self._to_wire(system, messages),
            "stream": False,
        }
        if tools:
            payload["tools"] = tools

        try:
            response = httpx.post(f"{self._url}/api/chat", json=payload, timeout=config.TIMEOUT)
            response.raise_for_status()
            body = response.json()
        except httpx.ConnectError as exc:
            raise LLMError(
                f"Could not reach Ollama at {self._url}. Is it running? Try: ollama serve"
            ) from exc
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text[:200]
            if exc.response.status_code == 404:
                raise LLMError(
                    f"Ollama has no model named {self.model!r}. Pull it: ollama pull {self.model}"
                ) from exc
            raise LLMError(f"Ollama error {exc.response.status_code}: {detail}") from exc
        except httpx.TimeoutException as exc:
            raise LLMError(f"Ollama timed out after {config.TIMEOUT}s.") from exc

        message = body.get("message") or {}
        calls = []
        for raw in message.get("tool_calls") or []:
            function = raw.get("function") or {}
            arguments = function.get("arguments")
            if isinstance(arguments, str):
                # Some builds return the arguments as a JSON string.
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    arguments = {}
            calls.append(
                ToolCall(
                    id=f"call_{uuid.uuid4().hex[:12]}",  # Ollama supplies none
                    name=function.get("name", ""),
                    arguments=arguments if isinstance(arguments, dict) else {},
                )
            )

        return Reply(
            text=(message.get("content") or "").strip(),
            tool_calls=calls,
            stop_reason="tool_use" if calls else (body.get("done_reason") or "end_turn"),
            usage={
                "input_tokens": body.get("prompt_eval_count"),
                "output_tokens": body.get("eval_count"),
            },
        )

    def health(self) -> dict:
        info: dict[str, Any] = {"provider": self.name, "model": self.model, "url": self._url}
        try:
            response = httpx.get(f"{self._url}/api/tags", timeout=3)
            response.raise_for_status()
            names = [m["name"] for m in response.json().get("models", [])]
            info["reachable"] = True
            # A model name may or may not carry a ":tag" — match on either form.
            info["model_present"] = any(
                n == self.model or n.split(":")[0] == self.model.split(":")[0] for n in names
            )
            info["models_available"] = names
        except Exception as exc:  # noqa: BLE001 - health must never raise
            info["reachable"] = False
            info["error"] = str(exc)
        return info


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------

_PROVIDERS = {"anthropic": AnthropicProvider, "ollama": OllamaProvider}
_cached: dict[str, Provider] = {}


def get_provider(name: str | None = None) -> Provider:
    """The configured provider, built once and reused (clients hold connections)."""
    key = (name or config.PROVIDER).lower()
    if key not in _PROVIDERS:
        raise LLMError(f"Unknown ASSISTANT_PROVIDER {key!r}. Use one of: {', '.join(_PROVIDERS)}.")
    if key not in _cached:
        _cached[key] = _PROVIDERS[key]()
    return _cached[key]


def tool_payload(provider: Provider) -> list[dict]:
    """The tool schemas in the shape this provider expects.

    The only place the two envelopes are chosen between — everything else works
    from the single set of schemas in tools.py.
    """
    return tool_schemas.for_anthropic() if provider.name == "anthropic" else tool_schemas.for_openai()
