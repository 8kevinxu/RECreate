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
# Claude Opus 5 is the default. For a task this narrow — pick a tool, phrase the
# facts it returns — a smaller model is a reasonable economy; set
# ANTHROPIC_MODEL=claude-haiku-4-5 if you want it.
ANTHROPIC_MODEL = _env("ANTHROPIC_MODEL", "claude-opus-5")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY") or ""

# Effort governs how much the model deliberates, and is the main cost/latency
# lever. "low" suits this workload: the reasoning is already done in Python, so
# the model only has to choose a tool and write a sentence.
ANTHROPIC_EFFORT = _env("ANTHROPIC_EFFORT", "low")

# Generous on purpose. Thinking is ON by default on Claude Opus 5, and max_tokens
# caps thinking PLUS the visible reply — size it for the answer alone and a long
# deliberation truncates the sentence the user was waiting for.
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


def summary() -> dict:
    """Non-secret config, surfaced by /health. Never include the API key."""
    return {
        "provider": PROVIDER,
        "model": ANTHROPIC_MODEL if PROVIDER == "anthropic" else OLLAMA_MODEL,
        "has_anthropic_key": bool(ANTHROPIC_API_KEY),
        "effort": ANTHROPIC_EFFORT if PROVIDER == "anthropic" else None,
        "max_steps": MAX_STEPS,
        "max_tokens": MAX_TOKENS,
    }
