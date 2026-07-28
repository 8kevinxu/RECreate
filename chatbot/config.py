"""Configuration, all from the environment.

Copy `.env.example` to `.env` and edit. Nothing here is secret except
ANTHROPIC_API_KEY, which stays server-side — the app talks to this service, not
to a model provider, so no key ever reaches a phone.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")


def _env(name: str, default: str) -> str:
    return (os.environ.get(name) or default).strip()


# Which provider llm.py talks to: "anthropic" | "ollama".
PROVIDER = _env("ASSISTANT_PROVIDER", "ollama").lower()

# --- Anthropic ---------------------------------------------------------------
# Haiku is the default, and the workload is the reason. Every fact in an answer
# was already retrieved by deterministic Python; the model chooses a tool, fills
# its arguments, and writes one sentence around the result. That is not a task
# where a frontier model earns its price, and this is the single largest cost
# lever in the service — the one to reach for before rate limits and budgets,
# because it lowers the cost of every legitimate request rather than capping how
# many of them are allowed. Set ANTHROPIC_MODEL=claude-opus-5 if a specific
# question is being answered badly and you want to see whether the model is why.
ANTHROPIC_MODEL = _env("ANTHROPIC_MODEL", "claude-haiku-4-5")

# Server-side only, and worth keeping on a dedicated key: an API key scoped to
# one Anthropic workspace can carry its own spend limit, so a runaway here
# cannot reach the credits that `npm run build:classes` depends on.
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY") or ""

# Effort governs how much the model deliberates, and is the main cost/latency
# lever. "low" suits this workload: the reasoning is already done in Python, so
# the model only has to choose a tool and write a sentence.
ANTHROPIC_EFFORT = _env("ANTHROPIC_EFFORT", "low")

# Generous on purpose. On models that think before answering, max_tokens caps
# thinking PLUS the visible reply — size it for the answer alone and a long
# deliberation truncates the sentence the user was waiting for. This is a ceiling,
# not an allocation: a one-sentence answer bills for one sentence.
MAX_TOKENS = int(_env("ASSISTANT_MAX_TOKENS", "8192"))

# --- Ollama ------------------------------------------------------------------
OLLAMA_URL = _env("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = _env("OLLAMA_MODEL", "llama3.1:8b")

# --- Agent loop --------------------------------------------------------------
# Hard ceiling on tool round-trips per question. A model that keeps calling tools
# without answering would otherwise bill forever; three or four is plenty for a
# compound question ("is the pool open Saturday and what does it cost?").
MAX_STEPS = int(_env("ASSISTANT_MAX_STEPS", "6"))

# Seconds to wait on the model. Ollama on a laptop is slow the first time a model
# is paged into memory.
TIMEOUT = float(_env("ASSISTANT_TIMEOUT", "120"))


# --- Serving -----------------------------------------------------------------
# Everything below exists because this service spends money per request. On a
# laptop none of it matters; on a reachable port all of it does.


def _list(name: str, default: str) -> list[str]:
    return [item.strip() for item in _env(name, default).split(",") if item.strip()]


# Shared token the app sends as `Authorization: Bearer <token>`. Empty disables
# the check, which is the right default for localhost and the wrong one anywhere
# else — app.py logs a warning at boot when it is unset.
#
# **This token is not a secret.** It ships inlined in the app bundle (it has to:
# the client is the thing presenting it), and anything in a bundle can be pulled
# back out of a downloaded binary. It stops casual traffic — a scanner that finds
# an open port, someone who reads the URL out of the JS — and nothing more
# determined than that. The limits below are the actual protection, because they
# hold even against a caller holding a valid token.
AUTH_TOKEN = os.environ.get("ASSISTANT_TOKEN") or ""

# Origins allowed to call this from a browser. "*" is right for local dev and
# wrong in production: narrow it to the web build's real origin. Native apps
# don't send Origin at all, so this only ever governs the web build.
ALLOWED_ORIGINS = _list("ASSISTANT_ALLOWED_ORIGINS", "*")

# Per-caller rate limits, keyed by IP. Sized for a person rather than a script: a
# curious user asks a few questions in a row, gets an answer, and goes to play.
# 0 disables a limit.
RATE_LIMIT_PER_MIN = int(_env("ASSISTANT_RATE_PER_MIN", "6"))
RATE_LIMIT_PER_DAY = int(_env("ASSISTANT_RATE_PER_DAY", "100"))

# The backstop, and the one that actually bounds the bill: total answered
# questions across all callers in any 24h window. A distributed caller defeats
# per-IP limits by definition — this is what a thousand IPs cannot get around.
# Set it to a number of requests you would be content to pay for on your worst
# day, because that is precisely what it buys.
DAILY_BUDGET = int(_env("ASSISTANT_DAILY_BUDGET", "1000"))

# Read the caller's IP from X-Forwarded-For. Correct behind a proxy that sets it
# (Fly, Render, nginx), and a rate-limit bypass without one — any caller could
# forge the header and mint a fresh identity per request.
TRUST_PROXY = _env("ASSISTANT_TRUST_PROXY", "false").lower() in ("1", "true", "yes")


def summary() -> dict:
    """Non-secret config, surfaced by /health. Never include the API key."""
    return {
        "provider": PROVIDER,
        "model": ANTHROPIC_MODEL if PROVIDER == "anthropic" else OLLAMA_MODEL,
        "has_anthropic_key": bool(ANTHROPIC_API_KEY),
        "effort": ANTHROPIC_EFFORT if PROVIDER == "anthropic" else None,
        "max_steps": MAX_STEPS,
        "max_tokens": MAX_TOKENS,
        # Whether the door is locked — never the key to it.
        "auth_required": bool(AUTH_TOKEN),
        "rate_per_min": RATE_LIMIT_PER_MIN,
        "rate_per_day": RATE_LIMIT_PER_DAY,
        "daily_budget": DAILY_BUDGET,
    }
