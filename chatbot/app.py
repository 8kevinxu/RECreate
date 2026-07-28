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

**Not safe to expose publicly as written.** There is no authentication and no
rate limiting, and each request costs a model call. Fine on localhost or behind
something that provides both; not fine on an open port.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import agent
import config
import data
import llm
import tools

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("assistant")

@asynccontextmanager
async def lifespan(_: FastAPI):
    """Log what this process is actually running, once, at boot.

    Worth the four lines: the commonest confusion when an answer looks wrong is
    not knowing which model replied or how stale the snapshots are.
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
    yield


app = FastAPI(
    lifespan=lifespan,
    title="RECreate assistant",
    description="Grounded Q&A over the app's own court, pool and class data.",
    version="1.0.0",
)

# Wide open because the browser build is served from a different origin and this
# only ever runs locally. Narrow it to the real origins before deploying.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


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

    Deliberately more than `{"ok": true}` — the three things that break in
    practice are the snapshots being missing, the model backend being
    unreachable, and the service running a different model than you assumed. All
    three are visible here.
    """
    provider_health: dict
    try:
        provider_health = llm.get_provider().health()
    except llm.LLMError as exc:
        provider_health = {"reachable": False, "error": str(exc)}

    snapshots = data.stats()
    ready = bool(snapshots["courts"]) and provider_health.get("reachable") is not False
    return {
        "status": "ok" if ready else "degraded",
        "config": config.summary(),
        "provider": provider_health,
        "data": snapshots,
        "tools": tools.names(),
    }


@app.post("/chat")
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

    log.info(
        "answered in %d step(s) via %s [%s]",
        len(result.steps), result.provider, result.stopped_because,
    )
    return result.to_dict(debug=request.debug)
