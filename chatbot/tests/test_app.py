"""Tests for the HTTP layer.

The agent is patched out, so these test the *contract* — validation, status
codes, what leaks and what doesn't — rather than re-testing the loop. No model is
contacted.
"""

import pytest
from fastapi.testclient import TestClient

import agent
import app as service
import data
import llm

client = TestClient(service.app)


@pytest.fixture
def canned(monkeypatch):
    """Replace the agent with a recorded answer, capturing what it was passed."""
    seen = {}

    def fake(messages, state=None, *, debug=False, provider=None):
        seen.update(messages=messages, state=state, debug=debug)
        result = agent.Answer(reply="Mission Rec is open until 5PM.", provider="scripted", model="m1")
        result.steps.append(
            agent.Step(tool="find_courts", arguments={"sport": "basketball"}, ok=True, ms=3,
                       result_chars=200, result={"sport": "basketball"})
        )
        result.usage = {"input_tokens": 100}
        return result

    monkeypatch.setattr(service.agent, "answer", fake)
    return seen


def post(body):
    return client.post("/chat", json=body)


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------


class TestHealth:
    def test_reports_the_shape_of_the_world(self):
        body = client.get("/health").json()
        assert body["status"] in ("ok", "degraded")
        assert body["data"]["courts"] > 500
        assert "find_courts" in body["tools"]

    def test_reports_which_model_it_thinks_it_is_running(self):
        # The third-most-common confusion after "snapshots missing" and "backend
        # down" is not knowing which model answered.
        assert client.get("/health").json()["config"]["model"]

    def test_never_leaks_the_api_key(self, monkeypatch):
        monkeypatch.setattr(service.config, "ANTHROPIC_API_KEY", "sk-secret-value")
        assert "sk-secret-value" not in client.get("/health").text

    def test_degrades_rather_than_erroring_when_the_provider_is_broken(self, monkeypatch):
        def boom(*a, **k):
            raise llm.LLMError("no ANTHROPIC_API_KEY set")

        monkeypatch.setattr(service.llm, "get_provider", boom)
        body = client.get("/health").json()
        assert body["status"] == "degraded"
        assert "ANTHROPIC_API_KEY" in body["provider"]["error"]


# ---------------------------------------------------------------------------
# /chat happy path
# ---------------------------------------------------------------------------


class TestChat:
    def test_answers(self, canned):
        body = post({"messages": [{"role": "user", "content": "any basketball?"}]}).json()
        assert body["reply"] == "Mission Rec is open until 5PM."
        assert body["tools_used"] == ["find_courts"]

    def test_state_reaches_the_agent(self, canned):
        post({
            "messages": [{"role": "user", "content": "near me?"}],
            "state": {"city": "nyc", "lat": 40.7, "lng": -73.9},
        })
        assert canned["state"] == {"city": "nyc", "lat": 40.7, "lng": -73.9}

    def test_absent_state_is_omitted_rather_than_sent_as_nulls(self, canned):
        post({"messages": [{"role": "user", "content": "hi"}]})
        assert canned["state"] == {}

    def test_multi_turn_history_is_passed_through(self, canned):
        post({"messages": [
            {"role": "user", "content": "any tennis?"},
            {"role": "assistant", "content": "Yes, three courts."},
            {"role": "user", "content": "which is closest?"},
        ]})
        assert len(canned["messages"]) == 3
        assert canned["messages"][-1]["content"] == "which is closest?"

    def test_debug_is_off_by_default_and_hides_internals(self, canned):
        body = post({"messages": [{"role": "user", "content": "hi"}]}).json()
        assert "steps" not in body and "usage" not in body

    def test_debug_true_returns_the_audit_trail(self, canned):
        body = post({"messages": [{"role": "user", "content": "hi"}], "debug": True}).json()
        assert body["steps"][0]["tool"] == "find_courts"
        assert body["usage"] == {"input_tokens": 100}


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class TestValidation:
    def test_no_messages_is_rejected(self):
        assert post({"messages": []}).status_code == 422

    def test_a_bad_role_is_rejected(self):
        assert post({"messages": [{"role": "wizard", "content": "hi"}]}).status_code == 422

    def test_empty_content_is_rejected(self):
        assert post({"messages": [{"role": "user", "content": ""}]}).status_code == 422

    def test_an_overlong_message_is_rejected(self):
        assert post({"messages": [{"role": "user", "content": "x" * 3000}]}).status_code == 422

    def test_an_overlong_conversation_is_rejected(self):
        many = [{"role": "user", "content": "hi"}] * 40
        assert post({"messages": many}).status_code == 422

    def test_impossible_coordinates_are_rejected(self):
        response = post({
            "messages": [{"role": "user", "content": "hi"}],
            "state": {"lat": 91, "lng": 0},
        })
        assert response.status_code == 422

    def test_a_missing_body_is_rejected(self):
        assert client.post("/chat").status_code == 422


# ---------------------------------------------------------------------------
# Error mapping
# ---------------------------------------------------------------------------


class TestErrors:
    def test_a_provider_failure_is_a_503_with_the_actionable_message(self, monkeypatch):
        def boom(*a, **k):
            raise llm.LLMError("Could not reach Ollama. Is it running? Try: ollama serve")

        monkeypatch.setattr(service.agent, "answer", boom)
        response = post({"messages": [{"role": "user", "content": "hi"}]})
        assert response.status_code == 503
        assert "ollama serve" in response.json()["detail"]

    def test_missing_snapshots_are_a_503_naming_the_fix(self, monkeypatch):
        def boom(*a, **k):
            raise data.SnapshotMissing("Missing courts.json. Run: npm run export:chatbot")

        monkeypatch.setattr(service.agent, "answer", boom)
        response = post({"messages": [{"role": "user", "content": "hi"}]})
        assert response.status_code == 503
        assert "export:chatbot" in response.json()["detail"]

    def test_an_unexpected_error_is_a_500_that_leaks_nothing(self, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("secret internal detail: /Users/kevin/private")

        monkeypatch.setattr(service.agent, "answer", boom)
        response = post({"messages": [{"role": "user", "content": "hi"}]})
        assert response.status_code == 500
        assert "secret internal detail" not in response.text
        assert "/Users/kevin" not in response.text


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------


class TestWiring:
    def test_the_chat_handler_is_sync_so_fastapi_threadpools_it(self):
        # An `async def` around agent.answer() would block the event loop for the
        # whole process on every question, serialising all callers.
        import inspect

        assert not inspect.iscoroutinefunction(service.chat)
        assert not inspect.iscoroutinefunction(service.health)

    def test_cors_is_enabled(self):
        response = client.options(
            "/chat",
            headers={"Origin": "http://localhost:8081", "Access-Control-Request-Method": "POST"},
        )
        assert response.headers.get("access-control-allow-origin") == "*"

    def test_health_needs_no_body(self):
        assert client.get("/health").status_code == 200
