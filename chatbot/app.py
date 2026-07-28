"""The HTTP service the app talks to.

    GET  /health   is everything wired up, and what does it think it's running?
    POST /chat     one question in, one answer out

Two endpoints, no state, no database. A conversation lives in the client and is
posted back in full each time — the same shape the model APIs use, and the reason
this can be restarted mid-conversation without losing anything.

**The handlers are sync `def`, deliberately.** `agent.answer()` blocks for
seconds — 20+ on a local model — and FastAPI runs a sync handler in a worker
thread, so concurrent requests proceed. Declaring `async def` around blocking
calls would instead freeze the event loop for the whole process on every
question, serialising all users behind one model call. This is the single easiest
way to make a service like this appear to hang under light load.

**Every request costs a model call**, which is what the auth check, the per-IP
rate limits and the global daily budget below are all defending. They default to
off-but-configured: no token means no auth, which is right on a laptop and wrong
on a reachable port, so boot logs a warning when it sees that combination rather
than either failing to start or quietly staying open.
"""

from __future__ import annotations

import logging
import secrets
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import agent
import config
import data
import limits
import llm
import tools

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("assistant")

# One limiter for the process. Its state is in-memory, so this is also the thing
# that makes the service single-worker by design — see limits.py.
limiter = limits.Limiter(
    per_minute=config.RATE_LIMIT_PER_MIN,
    per_day=config.RATE_LIMIT_PER_DAY,
    daily_budget=config.DAILY_BUDGET,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Log what this process is actually running, once, at boot.

    Worth the lines: the commonest confusion when an answer looks wrong is not
    knowing which model replied or how stale the snapshots are. The posture line
    exists for a different failure — deploying with the dev defaults still in
    place, which costs money rather than correctness and is otherwise silent.
    """
    snapshots = data.stats()
    log.info(
        "assistant ready — %s/%s, %d courts, %d classes, data generated %s",
        config.PROVIDER,
        config.summary()["model"],
        snapshots["courts"],
        snapshots["classes"],
        snapshots["generatedAt"],
    )
    log.info(
        "limits — %s, %s/min, %s/day per caller, %s/day total",
        "auth required" if config.AUTH_TOKEN else "NO AUTH",
        config.RATE_LIMIT_PER_MIN or "unlimited",
        config.RATE_LIMIT_PER_DAY or "unlimited",
        config.DAILY_BUDGET or "unlimited",
    )
    if not config.AUTH_TOKEN:
        log.warning(
            "ASSISTANT_TOKEN is unset: anyone who can reach this port can spend "
            "your model credits. Fine on localhost; set it before deploying."
        )
    if "*" in config.ALLOWED_ORIGINS:
        log.warning(
            "CORS is open to every origin. Set ASSISTANT_ALLOWED_ORIGINS to the "
            "web build's origin before deploying."
        )
    yield


app = FastAPI(
    lifespan=lifespan,
    title="RECreate assistant",
    description="Grounded Q&A over the app's own court, pool and class data.",
    version="1.0.0",
)

# Defaults to "*" for local dev, where the web build is served from a different
# origin every time you change ports. Set ASSISTANT_ALLOWED_ORIGINS in production.
#
# Worth being clear about what this does and doesn't buy: CORS is enforced by
# browsers, so narrowing it stops a web page on another origin from spending your
# credits with your users' tokens. It does nothing whatsoever against curl. The
# token and the limits are what cover that case.
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Admission: who may ask, and how often
# ---------------------------------------------------------------------------


def require_auth(request: Request) -> None:
    """Check the shared token, if one is configured.

    Accepts `Authorization: Bearer <token>` or `X-Assistant-Token`. Compared with
    `compare_digest` rather than `==` so the comparison doesn't return earlier for
    a wrong first character than a wrong last one; the timing signal is small over
    a network but the fix is one function call.

    No token configured means no check — the localhost default. That is a
    deliberate hole with a warning attached at boot, not an oversight: requiring a
    token to run the thing on your own machine is the kind of friction that gets
    routed around with a token committed to the repo.
    """
    if not config.AUTH_TOKEN:
        return

    header = request.headers.get("authorization", "")
    supplied = header[7:].strip() if header[:7].lower() == "bearer " else ""
    if not supplied:
        supplied = request.headers.get("x-assistant-token", "").strip()

    if not secrets.compare_digest(supplied.encode(), config.AUTH_TOKEN.encode()):
        # No detail about what was wrong with it. "Bad token" and "no token"
        # are the same answer to someone probing.
        raise HTTPException(status_code=401, detail="Not authorised.")


def enforce_limits(request: Request) -> None:
    """Admit the request, or refuse it with a `Retry-After`.

    Runs after auth so a caller without a token can't consume another caller's
    budget by being refused expensively.
    """
    key = limits.client_key(request, config.TRUST_PROXY)
    try:
        limiter.check(key)
    except limits.RateLimited as exc:
        if exc.scope == "budget":
            # Distinguishable in the logs from ordinary per-caller throttling,
            # because it means the service has stopped answering for everyone and
            # somebody should know that without being told by a user.
            log.error("daily budget exhausted — refusing until the window rolls")
        else:
            log.info("rate limited %s (%s)", key, exc.scope)
        raise HTTPException(
            status_code=429,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc


# ---------------------------------------------------------------------------
# Request and response shapes
# ---------------------------------------------------------------------------
# The limits are cheap insurance rather than security: every request costs a
# model call, and an unbounded conversation would be paid for in full each turn.


class Message(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1, max_length=2000)


class State(BaseModel):
    """What the app knows and the model must never guess.

    The screen fields arrived with the floating launcher: reached from a button
    that sits over whatever you were doing, a question usually has an on-screen
    subject, and "is it open tomorrow?" is unanswerable without it. They are
    pointers, not facts — `court_id` tells the model which court to look up, and
    every hour and price still comes from a tool.
    """

    city: str | None = Field(default=None, description="Active city id, e.g. 'sf'")
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    screen: str | None = Field(default=None, max_length=32, description="'map' | 'court' | 'classes' | 'profile'")
    court_id: str | None = Field(default=None, max_length=120, description="Court whose card is open")
    court_name: str | None = Field(default=None, max_length=200)
    sport: str | None = Field(default=None, max_length=32, description="Sport currently being viewed")


class ChatRequest(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=30)
    state: State = Field(default_factory=State)
    debug: bool = Field(default=False, description="Include the tool calls that produced the answer")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
def health() -> dict:
    """Is this thing actually able to answer?

    Deliberately more than `{"ok": true}` — the things that break in practice are
    the snapshots being missing, the model backend being unreachable, the service
    running a different model than you assumed, and (since it started refusing
    work) the budget being spent. All four are visible here.

    Left unauthenticated on purpose. It makes no model call, so it cannot be used
    to spend anything, and an uptime check that needs a credential is an uptime
    check that eventually gets turned off. It reports posture — whether auth is on
    — but never the token, and nothing about individual callers.
    """
    provider_health: dict
    try:
        provider_health = llm.get_provider().health()
    except llm.LLMError as exc:
        provider_health = {"reachable": False, "error": str(exc)}

    snapshots = data.stats()
    usage = limiter.snapshot()
    exhausted = bool(usage["daily_budget"]) and usage["used_today"] >= usage["daily_budget"]
    ready = (
        bool(snapshots["courts"])
        and provider_health.get("reachable") is not False
        and not exhausted
    )
    return {
        "status": "ok" if ready else "degraded",
        "config": config.summary(),
        "provider": provider_health,
        "data": snapshots,
        "limits": usage,
        "tools": tools.names(),
    }


@app.post("/chat", dependencies=[Depends(require_auth), Depends(enforce_limits)])
def chat(request: ChatRequest) -> dict:
    """Answer the latest message in `messages`.

    Errors are mapped so the client can tell apart "this service is misconfigured"
    (503, worth showing a real message) from "something broke" (500, don't leak
    internals). A model-backend failure is a 503 because the correct client
    behaviour is to retry or fall back to the app's normal UI, not to show the
    user a stack trace.
    """
    payload = [message.model_dump() for message in request.messages]
    state = request.state.model_dump(exclude_none=True)

    try:
        result = agent.answer(payload, state, debug=request.debug)
    except llm.LLMError as exc:
        # Provider down, missing key, model not pulled — all actionable, and all
        # phrased for a human by llm.py.
        log.warning("provider unavailable: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except data.SnapshotMissing as exc:
        log.error("snapshots missing: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - never leak an internal error outward
        log.exception("unhandled error answering question")
        raise HTTPException(status_code=500, detail="The assistant failed to answer.") from exc

    # Token counts are logged on every answer, not just in debug. They're the only
    # per-request record of what this cost, and the question you want them for
    # ("why was the bill that?") is always asked about traffic that has already
    # happened — by which time turning logging on is too late.
    usage = result.usage or {}
    log.info(
        "answered in %d step(s) via %s [%s] in=%s out=%s cached=%s",
        len(result.steps),
        result.provider,
        result.stopped_because,
        usage.get("input_tokens", "?"),
        usage.get("output_tokens", "?"),
        usage.get("cache_read_input_tokens", "?"),
    )
    return result.to_dict(debug=request.debug)
