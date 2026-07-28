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
import limits
import llm

client = TestClient(service.app)


@pytest.fixture(autouse=True)
def _fresh_limits():
    """Give every test its own empty rate-limit state.

    The limiter is one object for the process and every test calls from the same
    host, so without this the suite throttles itself: the seventh request in a
    file would 429 for reasons having nothing to do with what was being tested,
    and which test failed would depend on execution order.
    """
    service.limiter.reset()
    yield
    service.limiter.reset()


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


# ---------------------------------------------------------------------------
# Admission: auth and limits
# ---------------------------------------------------------------------------


class TestAuth:
    def test_open_when_no_token_is_configured(self, canned):
        # The localhost default. Requiring a credential to run this on your own
        # machine is the kind of friction that ends with a token in the repo.
        assert post({"messages": [{"role": "user", "content": "hi"}]}).status_code == 200

    def test_a_configured_token_is_required(self, canned, monkeypatch):
        monkeypatch.setattr(service.config, "AUTH_TOKEN", "s3cret")
        assert post({"messages": [{"role": "user", "content": "hi"}]}).status_code == 401

    def test_a_bearer_token_is_accepted(self, canned, monkeypatch):
        monkeypatch.setattr(service.config, "AUTH_TOKEN", "s3cret")
        response = client.post(
            "/chat",
            json={"messages": [{"role": "user", "content": "hi"}]},
            headers={"Authorization": "Bearer s3cret"},
        )
        assert response.status_code == 200

    def test_the_header_scheme_is_case_insensitive(self, canned, monkeypatch):
        monkeypatch.setattr(service.config, "AUTH_TOKEN", "s3cret")
        response = client.post(
            "/chat",
            json={"messages": [{"role": "user", "content": "hi"}]},
            headers={"Authorization": "bearer s3cret"},
        )
        assert response.status_code == 200

    def test_the_x_header_also_works(self, canned, monkeypatch):
        monkeypatch.setattr(service.config, "AUTH_TOKEN", "s3cret")
        response = client.post(
            "/chat",
            json={"messages": [{"role": "user", "content": "hi"}]},
            headers={"X-Assistant-Token": "s3cret"},
        )
        assert response.status_code == 200

    def test_a_wrong_token_is_refused(self, canned, monkeypatch):
        monkeypatch.setattr(service.config, "AUTH_TOKEN", "s3cret")
        response = client.post(
            "/chat",
            json={"messages": [{"role": "user", "content": "hi"}]},
            headers={"Authorization": "Bearer wrong"},
        )
        assert response.status_code == 401

    def test_the_refusal_says_nothing_useful_to_a_prober(self, canned, monkeypatch):
        monkeypatch.setattr(service.config, "AUTH_TOKEN", "s3cret")
        response = client.post(
            "/chat",
            json={"messages": [{"role": "user", "content": "hi"}]},
            headers={"Authorization": "Bearer wrong"},
        )
        assert "s3cret" not in response.text
        assert response.json()["detail"] == "Not authorised."

    def test_an_unauthorised_request_never_reaches_the_model(self, canned, monkeypatch):
        # The whole point: a refused request must not cost anything.
        monkeypatch.setattr(service.config, "AUTH_TOKEN", "s3cret")
        post({"messages": [{"role": "user", "content": "hi"}]})
        assert "messages" not in canned

    def test_health_stays_open(self, monkeypatch):
        # An uptime check that needs a credential is one that gets turned off,
        # and /health makes no model call so it can't be used to spend anything.
        monkeypatch.setattr(service.config, "AUTH_TOKEN", "s3cret")
        assert client.get("/health").status_code == 200

    def test_health_reports_that_auth_is_on_but_never_the_token(self, monkeypatch):
        monkeypatch.setattr(service.config, "AUTH_TOKEN", "s3cret")
        body = client.get("/health")
        assert body.json()["config"]["auth_required"] is True
        assert "s3cret" not in body.text


class TestRateLimiting:
    def test_a_burst_is_refused_with_a_retry_after(self, canned, monkeypatch):
        monkeypatch.setattr(service, "limiter", limits.Limiter(per_minute=2))
        for _ in range(2):
            assert post({"messages": [{"role": "user", "content": "hi"}]}).status_code == 200
        response = post({"messages": [{"role": "user", "content": "hi"}]})
        assert response.status_code == 429
        assert int(response.headers["Retry-After"]) >= 1

    def test_a_limited_request_never_reaches_the_model(self, canned, monkeypatch):
        monkeypatch.setattr(service, "limiter", limits.Limiter(per_minute=1))
        post({"messages": [{"role": "user", "content": "first"}]})
        post({"messages": [{"role": "user", "content": "second"}]})
        # The agent saw the first question and not the second.
        assert canned["messages"][-1]["content"] == "first"

    def test_the_budget_refusal_explains_itself(self, canned, monkeypatch):
        monkeypatch.setattr(service, "limiter", limits.Limiter(daily_budget=1))
        post({"messages": [{"role": "user", "content": "hi"}]})
        response = post({"messages": [{"role": "user", "content": "hi"}]})
        assert response.status_code == 429
        assert "daily limit" in response.json()["detail"]

    def test_health_goes_degraded_when_the_budget_is_gone(self, canned, monkeypatch):
        # "Why did it stop answering?" should be answerable without reading logs.
        monkeypatch.setattr(service, "limiter", limits.Limiter(daily_budget=1))
        post({"messages": [{"role": "user", "content": "hi"}]})
        assert client.get("/health").json()["status"] == "degraded"

    def test_health_reports_budget_consumption(self, canned, monkeypatch):
        monkeypatch.setattr(service, "limiter", limits.Limiter(daily_budget=50))
        post({"messages": [{"role": "user", "content": "hi"}]})
        assert client.get("/health").json()["limits"]["used_today"] == 1


class TestRequestLogging:
    """What the HTTP layer writes down about a request.

    The app's privacy label says location is not collected, which holds only
    while coordinates are used to answer and then dropped. `agent.py`'s own tests
    cover the model boundary; this covers the handler, which is where a
    "log the request so I can see what's failing" line would land.
    """

    def test_a_request_is_logged_without_its_contents(self, canned, caplog):
        with caplog.at_level("INFO"):
            post({
                "messages": [{"role": "user", "content": "where can I play near my house?"}],
                "state": {"city": "sf", "lat": 37.7123456, "lng": -122.4123456},
            })
        assert "37.7123456" not in caplog.text
        assert "-122.4123456" not in caplog.text
        assert "near my house" not in caplog.text

    def test_but_the_cost_of_it_is_logged(self, canned, caplog):
        # The counterpart: spend has to be attributable after the fact, and token
        # counts say nothing about the person who asked.
        with caplog.at_level("INFO"):
            post({"messages": [{"role": "user", "content": "hi"}]})
        assert "in=100" in caplog.text


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
