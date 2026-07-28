"""Rate limits and a hard daily ceiling on how much this service can spend.

Every answered question costs a model call, so the quantity that needs bounding
is not CPU or memory but money. Two mechanisms, aimed at different callers:

* **Per-IP limits** (`per_minute`, `per_day`) shape one caller into something
  resembling a person. They are the ones a user could plausibly hit, so they are
  sized to be invisible to real use and are reported with a `Retry-After`.
* **A global daily budget** is the one that actually bounds the bill. Per-IP
  limits are defeated by definition by a distributed caller — a botnet has as
  many identities as it wants. The global window does not care how many
  identities are involved, only how many questions have been answered, which is
  the thing being paid for.

Both are **sliding windows** rather than counters reset on the hour. A fixed
window lets a caller spend the whole budget in the last second of one window and
the whole budget again in the first second of the next; it also produces a
thundering herd at every reset. The cost is keeping timestamps rather than an
integer, which is bounded here by the limits themselves: a deque can never grow
past the limit that rejects appends to it.

State is in-memory and per-process, which is a real constraint worth stating: two
workers means two independent budgets, and a restart forgives every counter. For
a single-process service (what `uvicorn app:app` runs) that is exactly right, and
introducing Redis to fix it would add a network dependency to the request path
for a service whose whole point is to run simply. Scale past one worker and this
needs to move to shared storage.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

MINUTE = 60.0
DAY = 86400.0

# How often to sweep idle callers out of the table, in seconds. Pruning the
# caller we were handed is O(1) and happens every request; walking every caller
# we have ever seen is O(n) and does not need to.
SWEEP_EVERY = 300.0


class RateLimited(Exception):
    """A request was refused by a limit. `retry_after` is seconds, always ≥ 1.

    `scope` distinguishes "you are asking too fast" from "the service is done for
    today" — the caller can say something true rather than something generic, and
    the two deserve different words.
    """

    def __init__(self, message: str, retry_after: float, scope: str):
        super().__init__(message)
        self.retry_after = max(1, int(retry_after + 0.999))  # never advertise 0
        self.scope = scope


class Limiter:
    """Sliding-window limits over an injectable clock.

    The clock is a parameter so the tests can advance time by an hour without
    sleeping for one. It defaults to `time.monotonic`, not `time.time`, so the
    windows survive an NTP correction or a daylight-saving jump — wall-clock time
    can move backwards, and a limiter that trusts it can be tricked into
    forgiving every limit at once.
    """

    def __init__(
        self,
        *,
        per_minute: int = 0,
        per_day: int = 0,
        daily_budget: int = 0,
        clock=time.monotonic,
    ):
        self.per_minute = per_minute
        self.per_day = per_day
        self.daily_budget = daily_budget
        self._clock = clock
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._global: deque[float] = deque()
        self._last_sweep = clock()
        # Sync handlers run in FastAPI's threadpool, so two requests genuinely do
        # land here at once. Without the lock the check and the append are not
        # atomic and concurrent callers can both pass a limit that admits one.
        self._lock = threading.Lock()

    # -- public API ---------------------------------------------------------

    def check(self, key: str) -> None:
        """Admit one request from `key`, or raise `RateLimited`.

        Recording happens here rather than after the answer, so a question that
        fails downstream still counts. It consumed a model call either way, and a
        limiter that only counted successes would let a caller loop for free on
        whatever input reliably breaks the agent.
        """
        now = self._clock()
        with self._lock:
            self._maybe_sweep(now)

            if self.daily_budget:
                _expire(self._global, now - DAY)
                if len(self._global) >= self.daily_budget:
                    raise RateLimited(
                        "The assistant has reached its daily limit for everyone. "
                        "It will answer again tomorrow.",
                        retry_after=DAY - (now - self._global[0]),
                        scope="budget",
                    )

            hits = self._hits[key]
            _expire(hits, now - DAY)

            if self.per_day and len(hits) >= self.per_day:
                raise RateLimited(
                    "You've reached today's question limit.",
                    retry_after=DAY - (now - hits[0]),
                    scope="day",
                )

            if self.per_minute:
                cutoff = now - MINUTE
                recent = [stamp for stamp in hits if stamp > cutoff]
                if len(recent) >= self.per_minute:
                    raise RateLimited(
                        "Too many questions at once — give it a moment.",
                        retry_after=MINUTE - (now - recent[0]),
                        scope="minute",
                    )

            hits.append(now)
            if self.daily_budget:
                self._global.append(now)

    def snapshot(self) -> dict:
        """What the limits are and how much of the budget is gone.

        Surfaced by /health so "why did it stop answering?" has an answer that
        doesn't require reading the logs. Deliberately no per-caller detail: that
        would turn a public endpoint into a report on who has been using this.
        """
        now = self._clock()
        with self._lock:
            _expire(self._global, now - DAY)
            return {
                "per_minute": self.per_minute,
                "per_day": self.per_day,
                "daily_budget": self.daily_budget,
                "used_today": len(self._global),
                "callers": len(self._hits),
            }

    def reset(self) -> None:
        """Forget everything. For tests, and for a deliberate manual clear."""
        with self._lock:
            self._hits.clear()
            self._global.clear()

    # -- internals ----------------------------------------------------------

    def _maybe_sweep(self, now: float) -> None:
        """Drop callers with nothing left in their window.

        Without this the table grows one entry per distinct IP forever, which is
        a slow memory leak with an obvious trigger: point a scanner at it.
        """
        if now - self._last_sweep < SWEEP_EVERY:
            return
        self._last_sweep = now
        cutoff = now - DAY
        for key in [k for k, hits in self._hits.items() if not hits or hits[-1] <= cutoff]:
            del self._hits[key]


def _expire(stamps: deque[float], cutoff: float) -> None:
    """Drop timestamps at or before `cutoff`. Cheap because deques are ordered."""
    while stamps and stamps[0] <= cutoff:
        stamps.popleft()


def client_key(request, trust_proxy: bool) -> str:
    """Identify the caller for rate-limiting purposes.

    Behind a proxy the socket address is the proxy's, so every caller would share
    one bucket and the first busy user would lock out everyone else. The
    left-most X-Forwarded-For entry is the original client — but it is also
    caller-supplied text, so trusting it without a proxy in front lets anyone mint
    a fresh identity per request and bypass the per-IP limits entirely. Hence the
    flag: correct in both deployments, and wrong in neither by default.
    """
    if trust_proxy:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return getattr(request.client, "host", None) or "unknown"
