"""Tests for moment resolution and schedule reading.

Every assertion here is deterministic — no model, no network, and no dependence
on when the suite runs (anything relative is pinned by monkeypatching `now_in`).
This is the layer that decides whether an answer is factually right, so it gets
tested harder than anything else in the project.
"""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

import timeutil as tu

SF = ZoneInfo("America/Los_Angeles")
NYC = ZoneInfo("America/New_York")

# Friday, July 24 2026, 11:20 AM in San Francisco.
FRIDAY_LATE_MORNING = datetime(2026, 7, 24, 11, 20, tzinfo=SF)


@pytest.fixture
def frozen(monkeypatch):
    """Pin 'now' so relative words resolve predictably."""

    def _freeze(moment=FRIDAY_LATE_MORNING):
        monkeypatch.setattr(tu, "now_in", lambda city=None: moment)
        return moment

    return _freeze


# ---------------------------------------------------------------------------
# Weekday indexing — the data is 0=Sunday, Python is 0=Monday
# ---------------------------------------------------------------------------


class TestWeekdayIndex:
    def test_sunday_is_zero(self):
        assert tu.dow(datetime(2026, 7, 26, 12, 0, tzinfo=SF)) == 0

    def test_monday_is_one(self):
        assert tu.dow(datetime(2026, 7, 27, 12, 0, tzinfo=SF)) == 1

    def test_saturday_is_six(self):
        assert tu.dow(datetime(2026, 7, 25, 12, 0, tzinfo=SF)) == 6

    def test_every_day_maps_to_its_name(self):
        # Jul 26 2026 is a Sunday; walk a full week (crossing the month end) and
        # check the names line up.
        sunday = datetime(2026, 7, 26, 12, 0, tzinfo=SF)
        for offset, expected in enumerate(tu.DAY_NAMES):
            assert tu.DAY_NAMES[tu.dow(sunday + timedelta(days=offset))] == expected


def test_minutes_of():
    assert tu.minutes_of(datetime(2026, 7, 24, 0, 0, tzinfo=SF)) == 0
    assert tu.minutes_of(datetime(2026, 7, 24, 9, 30, tzinfo=SF)) == 570
    assert tu.minutes_of(datetime(2026, 7, 24, 23, 59, tzinfo=SF)) == 1439


# ---------------------------------------------------------------------------
# Formatting — must match the app's lib/hours.js exactly
# ---------------------------------------------------------------------------


class TestFormatting:
    @pytest.mark.parametrize(
        "mins,expected",
        [(0, "12AM"), (540, "9AM"), (570, "9:30AM"), (720, "12PM"), (1020, "5PM"), (1245, "8:45PM")],
    )
    def test_fmt_minutes(self, mins, expected):
        assert tu.fmt_minutes(mins) == expected

    def test_fmt_block_plain(self):
        assert tu.fmt_block([540, 1020]) == "9AM–5PM"

    def test_fmt_block_tagged(self):
        assert tu.fmt_block([1080, 1245, "women"]) == "6PM–8:45PM (women only)"

    def test_fmt_block_openplay(self):
        assert tu.fmt_block([540, 1020, "openplay"]) == "9AM–5PM (open play)"


# ---------------------------------------------------------------------------
# resolve_when
# ---------------------------------------------------------------------------


class TestResolveWhen:
    def test_none_and_now_mean_right_now(self, frozen):
        now = frozen()
        for value in (None, "", "now"):
            target = tu.resolve_when(value, "sf")
            assert target.moment == now
            assert target.granularity == "moment"
            assert "right now" in target.label

    def test_today_is_a_whole_day(self, frozen):
        frozen()
        target = tu.resolve_when("today", "sf")
        assert target.is_day
        assert target.dow == 5  # Friday
        assert "whole day" in target.label

    def test_tomorrow_advances_one_day(self, frozen):
        frozen()
        target = tu.resolve_when("tomorrow", "sf")
        assert target.dow == 6  # Saturday
        assert target.is_day

    def test_weekday_finds_the_next_one(self, frozen):
        frozen()  # a Friday
        assert tu.resolve_when("saturday", "sf").moment.day == 25
        assert tu.resolve_when("monday", "sf").moment.day == 27
        assert tu.resolve_when("sun", "sf").moment.day == 26

    def test_today_counts_as_the_next_such_weekday(self, frozen):
        frozen()  # Friday
        assert tu.resolve_when("friday", "sf").moment.day == 24

    def test_abbreviations_and_awkward_ones(self, frozen):
        frozen()
        for token in ("tue", "tues", "tuesday"):
            assert tu.resolve_when(token, "sf").dow == 2
        for token in ("thu", "thur", "thurs", "thursday"):
            assert tu.resolve_when(token, "sf").dow == 4

    def test_a_stale_year_is_rejected_rather_than_answered(self, frozen):
        # Observed: asked "is there lap swim Wednesday at 4pm", the model passed
        # 2023-07-27 — a Thursday, three years gone — and it resolved silently,
        # so the answer described the wrong day of the wrong year.
        frozen()
        with pytest.raises(tu.WhenError) as exc:
            tu.resolve_when("2023-07-27T16:00", "sf")
        message = str(exc.value)
        assert "past" in message
        # The message has to tell the model what to send instead, or it just
        # retries the same bad date until the step ceiling.
        assert "weekday name" in message

    def test_an_absurd_future_date_is_rejected(self, frozen):
        frozen()
        with pytest.raises(tu.WhenError):
            tu.resolve_when("2099-01-01", "sf")

    def test_dates_from_today_onward_still_work(self, frozen):
        frozen()  # Friday 2026-07-24
        assert tu.resolve_when("2026-07-24T16:00", "sf").moment.day == 24
        assert tu.resolve_when("2026-07-30", "sf").moment.day == 30

    def test_bare_time_means_today_at_that_time(self, frozen):
        frozen()
        target = tu.resolve_when("18:00", "sf")
        assert target.granularity == "moment"
        assert (target.moment.day, target.minutes) == (24, 1080)

    @pytest.mark.parametrize(
        "text,expected_minutes",
        [("6pm", 1080), ("6:30pm", 1110), ("10am", 600), ("12pm", 720), ("12am", 0), ("14:30", 870)],
    )
    def test_clock_formats(self, frozen, text, expected_minutes):
        frozen()
        assert tu.resolve_when(text, "sf").minutes == expected_minutes

    def test_day_and_time_combined(self, frozen):
        frozen()
        target = tu.resolve_when("saturday 10am", "sf")
        assert target.granularity == "moment"
        assert (target.moment.day, target.minutes, target.dow) == (25, 600, 6)

    def test_the_word_at_is_tolerated(self, frozen):
        frozen()
        assert tu.resolve_when("saturday at 10am", "sf").minutes == 600

    def test_vague_times_get_a_convention(self, frozen):
        frozen()
        assert tu.resolve_when("tonight", "sf").minutes == 19 * 60
        assert tu.resolve_when("tomorrow morning", "sf").minutes == 10 * 60
        assert tu.resolve_when("saturday afternoon", "sf").dow == 6

    def test_iso_date_is_a_whole_day(self):
        target = tu.resolve_when("2026-07-25", "sf")
        assert target.is_day
        assert (target.moment.month, target.moment.day) == (7, 25)

    def test_iso_datetime_is_a_moment(self):
        target = tu.resolve_when("2026-07-25T10:00", "sf")
        assert target.granularity == "moment"
        assert (target.moment.day, target.minutes) == (25, 600)

    def test_iso_with_a_space_still_parses(self):
        assert tu.resolve_when("2026-07-25 10:00", "sf").minutes == 600

    def test_label_states_the_resolved_moment(self):
        # The prompt shows this verbatim, so "open until 5PM" can't be misread as
        # relative to now. It must name the day, the time and the zone.
        label = tu.resolve_when("2026-07-25T10:00", "sf").label
        assert "Saturday" in label and "Jul 25" in label and "10AM" in label
        assert "PDT" in label or "PST" in label

    @pytest.mark.parametrize("bad", ["someday", "next never", "25:00", "13pm", "10:75"])
    def test_unparseable_raises_a_helpful_error(self, frozen, bad):
        frozen()
        with pytest.raises(tu.WhenError) as exc:
            tu.resolve_when(bad, "sf")
        assert "saturday" in str(exc.value).lower()  # the message lists valid forms


class TestResolveWhenUsesTheCityClock:
    def test_a_bare_time_lands_in_the_asked_city(self):
        # 10am is 10am wherever you ask about, but it's a different instant.
        sf = tu.resolve_when("2026-07-25T10:00", "sf")
        nyc = tu.resolve_when("2026-07-25T10:00", "nyc")
        assert sf.minutes == nyc.minutes == 600
        assert sf.moment.utcoffset() != nyc.moment.utcoffset()

    def test_now_differs_by_city(self):
        # Real clock, but the relationship holds regardless of when this runs.
        assert tu.now_in("nyc").utcoffset() > tu.now_in("sf").utcoffset()


# ---------------------------------------------------------------------------
# Reading a week
# ---------------------------------------------------------------------------
# Rossi pickleball, as the exporter resolves it: 8AM–8PM base with a 9AM–5PM
# open-play window carved out on Sunday/Tuesday/Thursday/Friday.
ROSSI = [
    [[480, 540], [540, 1020, "openplay"], [1020, 1200]],  # Sun
    [[480, 1200]],  # Mon
    [[480, 540], [540, 900, "openplay"], [900, 1200]],  # Tue
    [[480, 1200]],  # Wed
    [[480, 540], [540, 900, "openplay"], [900, 1200]],  # Thu
    [[480, 540], [540, 900, "openplay"], [900, 1200]],  # Fri
    [],  # Sat — closed, to prove gaps are reported honestly
]

MISSION_BASKETBALL = [[], [], [[540, 1020]], [[540, 1020]], [], [[540, 1020]], [[540, 1020]]]


def at(text, city="sf"):
    """Resolve an absolute `when` — no dependence on the real clock."""
    return tu.resolve_when(text, city)


class TestStatusAtAMoment:
    def test_open_inside_a_block(self):
        # Friday 4PM — inside the 3PM–8PM block that follows the open-play window.
        status = tu.status_at(ROSSI, at("2026-07-24T16:00"))
        assert status["open"] is True
        assert status["until"] == "8PM"
        assert status["minutes_left"] == 240
        assert status["restriction"] is None

    def test_restriction_is_surfaced(self):
        status = tu.status_at(ROSSI, at("2026-07-24T10:00"))  # Friday, in open play
        assert status["open"] is True
        assert status["restriction"] == "open play"
        assert "open play" in status["summary"]

    def test_closed_reports_next_opening_later_the_same_day(self):
        status = tu.status_at(ROSSI, at("2026-07-24T07:00"))  # Friday, before 8AM
        assert status["open"] is False
        assert status["next_open"] == {"day": "Friday", "at": "8AM"}
        assert "later that day" in status["summary"]

    def test_closed_reports_next_opening_on_a_later_day(self):
        # Saturday has no hours at all, so the next opening is Sunday.
        status = tu.status_at(ROSSI, at("2026-07-25T12:00"))
        assert status["open"] is False
        assert status["next_open"] == {"day": "Sunday", "at": "8AM"}

    def test_after_hours_rolls_to_the_next_day_with_hours(self):
        status = tu.status_at(ROSSI, at("2026-07-24T22:00"))  # Friday, after 8PM
        assert status["open"] is False
        assert status["next_open"]["day"] == "Sunday"  # Saturday is closed

    def test_a_block_end_is_exclusive(self):
        # 8PM ends the block; the app treats end as exclusive and so must we.
        assert tu.status_at(ROSSI, at("2026-07-24T19:59"))["open"] is True
        assert tu.status_at(ROSSI, at("2026-07-24T20:00"))["open"] is False

    def test_a_block_start_is_inclusive(self):
        assert tu.status_at(ROSSI, at("2026-07-24T08:00"))["open"] is True

    def test_empty_week_says_so_without_crashing(self):
        status = tu.status_at([[], [], [], [], [], [], []], at("2026-07-24T12:00"))
        assert status["open"] is False
        assert "No drop-in hours" in status["summary"]

    def test_every_answer_states_the_moment_it_judged(self):
        for when in ("2026-07-24T13:00", "2026-07-25T12:00", "2026-07-24T22:00"):
            assert "Jul" in tu.status_at(ROSSI, at(when))["asked_about"]


class TestStatusForAWholeDay:
    """A day question must describe the day, not test midnight.

    "Is Rossi open Saturday?" resolved to Saturday 00:00 would answer "closed" for
    a court open 8AM–8PM — technically about midnight, useless as an answer.
    """

    def test_a_day_with_hours_lists_them(self):
        status = tu.status_at(MISSION_BASKETBALL, at("2026-07-25"))  # Saturday
        assert status["open"] is True
        assert status["hours_that_day"] == "9AM–5PM"
        assert "Saturday" in status["summary"]

    def test_midnight_is_not_treated_as_closed(self):
        # The regression this granularity exists to prevent.
        day = tu.status_at(MISSION_BASKETBALL, at("2026-07-25"))
        moment = tu.status_at(MISSION_BASKETBALL, at("2026-07-25T00:00"))
        assert day["open"] is True
        assert moment["open"] is False

    def test_a_day_without_hours_is_honest(self):
        status = tu.status_at(MISSION_BASKETBALL, at("2026-07-23"))  # Thursday
        assert status["open"] is False
        assert "No drop-in hours Thursday" in status["summary"]

    def test_multiple_blocks_are_all_reported(self):
        status = tu.status_at(ROSSI, at("2026-07-24"))  # Friday
        assert status["hours_that_day"] == "8AM–9AM, 9AM–3PM (open play), 3PM–8PM"


class TestWeekViews:
    def test_day_label_joins_blocks(self):
        assert tu.day_label(ROSSI, 5) == "8AM–9AM, 9AM–3PM (open play), 3PM–8PM"

    def test_day_label_for_a_closed_day(self):
        assert tu.day_label(ROSSI, 6) == "closed"

    def test_week_rows_start_on_monday(self):
        rows = tu.week_rows(MISSION_BASKETBALL)
        assert [r["day"] for r in rows] == [
            "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
        ]

    def test_week_rows_carry_the_hours(self):
        rows = {r["day"]: r["hours"] for r in tu.week_rows(MISSION_BASKETBALL)}
        assert rows["Tuesday"] == "9AM–5PM"
        assert rows["Thursday"] == "closed"

    def test_blocks_on_tolerates_a_short_week(self):
        assert tu.blocks_on([], 3) == []
        assert tu.blocks_on([[[540, 600]]], 3) == []
