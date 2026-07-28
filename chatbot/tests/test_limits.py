"""Tests for the rate limiter and the daily budget.

Time is injected rather than slept through — a sliding window is only worth
having if it actually slides, and the way to test that in under a second is to
hand it a clock you control.
"""

import pytest

import limits


class FakeClock:
    """A monotonic clock that only moves when a test says so."""

    def __init__(self, start=1000.0):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


@pytest.fixture
def clock():
    return FakeClock()


def build(clock, **kwargs):
    return limits.Limiter(clock=clock, **kwargs)


# ---------------------------------------------------------------------------
# Per-caller limits
# ---------------------------------------------------------------------------


class TestPerCaller:
    def test_allows_up_to_the_limit_then_refuses(self, clock):
        limiter = build(clock, per_minute=3)
        for _ in range(3):
            limiter.check("1.1.1.1")
        with pytest.raises(limits.RateLimited):
            limiter.check("1.1.1.1")

    def test_callers_are_independent(self, clock):
        limiter = build(clock, per_minute=2)
        limiter.check("1.1.1.1")
        limiter.check("1.1.1.1")
        # A second caller is unaffected by the first hitting its limit.
        limiter.check("2.2.2.2")

    def test_the_window_slides(self, clock):
        limiter = build(clock, per_minute=2)
        limiter.check("1.1.1.1")
        limiter.check("1.1.1.1")
        clock.advance(61)
        limiter.check("1.1.1.1")  # the first two have aged out

    def test_a_partial_wait_is_not_enough(self, clock):
        # The distinction that separates a sliding window from a fixed one: at
        # t+30 the earlier hits are still inside the minute.
        limiter = build(clock, per_minute=2)
        limiter.check("1.1.1.1")
        limiter.check("1.1.1.1")
        clock.advance(30)
        with pytest.raises(limits.RateLimited):
            limiter.check("1.1.1.1")

    def test_the_daily_limit_is_separate_from_the_per_minute_one(self, clock):
        limiter = build(clock, per_minute=2, per_day=3)
        for _ in range(3):
            limiter.check("1.1.1.1")
            clock.advance(61)  # never trips the per-minute limit
        with pytest.raises(limits.RateLimited) as caught:
            limiter.check("1.1.1.1")
        assert caught.value.scope == "day"

    def test_zero_disables_a_limit(self, clock):
        limiter = build(clock, per_minute=0, per_day=0, daily_budget=0)
        for _ in range(200):
            limiter.check("1.1.1.1")


# ---------------------------------------------------------------------------
# The global budget
# ---------------------------------------------------------------------------


class TestDailyBudget:
    def test_caps_everyone_together(self, clock):
        # The point of the budget: unlike the per-IP limits, spreading the
        # requests across callers doesn't get around it.
        limiter = build(clock, daily_budget=3)
        limiter.check("1.1.1.1")
        limiter.check("2.2.2.2")
        limiter.check("3.3.3.3")
        with pytest.raises(limits.RateLimited) as caught:
            limiter.check("4.4.4.4")
        assert caught.value.scope == "budget"

    def test_it_recovers_after_the_window(self, clock):
        limiter = build(clock, daily_budget=1)
        limiter.check("1.1.1.1")
        with pytest.raises(limits.RateLimited):
            limiter.check("2.2.2.2")
        clock.advance(86401)
        limiter.check("2.2.2.2")

    def test_snapshot_reports_consumption(self, clock):
        limiter = build(clock, daily_budget=10)
        limiter.check("1.1.1.1")
        limiter.check("2.2.2.2")
        snap = limiter.snapshot()
        assert snap["used_today"] == 2
        assert snap["daily_budget"] == 10
        assert snap["callers"] == 2

    def test_snapshot_names_no_callers(self, clock):
        # A public /health endpoint reporting who has been using the service
        # would be a worse leak than the thing it's diagnosing.
        limiter = build(clock, daily_budget=10)
        limiter.check("198.51.100.7")
        assert "198.51.100.7" not in str(limiter.snapshot())


# ---------------------------------------------------------------------------
# Retry-After
# ---------------------------------------------------------------------------


class TestRetryAfter:
    def test_counts_down_as_the_window_ages(self, clock):
        limiter = build(clock, per_minute=1)
        limiter.check("1.1.1.1")
        with pytest.raises(limits.RateLimited) as first:
            limiter.check("1.1.1.1")
        clock.advance(50)
        with pytest.raises(limits.RateLimited) as later:
            limiter.check("1.1.1.1")
        assert later.value.retry_after < first.value.retry_after

    def test_is_never_zero(self, clock):
        # "Retry after 0 seconds" invites an immediate retry that fails again.
        limiter = build(clock, per_minute=1)
        limiter.check("1.1.1.1")
        clock.advance(59.99)
        with pytest.raises(limits.RateLimited) as caught:
            limiter.check("1.1.1.1")
        assert caught.value.retry_after >= 1


# ---------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------


class TestHousekeeping:
    def test_idle_callers_are_swept(self, clock):
        # Otherwise the table grows one entry per distinct IP forever, which a
        # scanner turns into a memory leak.
        limiter = build(clock, per_day=5)
        limiter.check("1.1.1.1")
        clock.advance(86401 + limits.SWEEP_EVERY)
        limiter.check("2.2.2.2")
        assert limiter.snapshot()["callers"] == 1

    def test_a_failed_request_still_counts(self, clock):
        # Recording on admission, not on success: a caller who found an input
        # that reliably breaks the agent would otherwise loop for free.
        limiter = build(clock, per_minute=1)
        limiter.check("1.1.1.1")
        with pytest.raises(limits.RateLimited):
            limiter.check("1.1.1.1")

    def test_reset_clears_everything(self, clock):
        limiter = build(clock, per_minute=1)
        limiter.check("1.1.1.1")
        limiter.reset()
        limiter.check("1.1.1.1")


# ---------------------------------------------------------------------------
# Caller identity
# ---------------------------------------------------------------------------


class Req:
    def __init__(self, host="1.1.1.1", headers=None):
        self.client = type("C", (), {"host": host})()
        self.headers = headers or {}


class TestClientKey:
    def test_uses_the_socket_address_by_default(self):
        assert limits.client_key(Req("9.9.9.9"), trust_proxy=False) == "9.9.9.9"

    def test_ignores_a_forged_forwarded_header_when_not_behind_a_proxy(self):
        # Without this, every caller mints a fresh identity per request and the
        # per-IP limits stop meaning anything.
        request = Req("9.9.9.9", {"x-forwarded-for": "1.2.3.4"})
        assert limits.client_key(request, trust_proxy=False) == "9.9.9.9"

    def test_reads_the_real_client_when_behind_a_proxy(self):
        request = Req("10.0.0.1", {"x-forwarded-for": "1.2.3.4, 10.0.0.1"})
        assert limits.client_key(request, trust_proxy=True) == "1.2.3.4"

    def test_falls_back_when_there_is_no_client(self):
        request = Req()
        request.client = None
        assert limits.client_key(request, trust_proxy=False) == "unknown"
