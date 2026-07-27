import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

# Tests import the service modules by their bare names (`import data`), the same
# way the service itself does, so the package root goes on the path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import data  # noqa: E402
import timeutil as tu  # noqa: E402

# The clock the whole suite runs on.
#
# Tests pin absolute dates (2026-07-23..25) precisely so results don't depend on
# when the suite runs. That only holds while nothing compares those dates to the
# real present — and something does now: `resolve_when` rejects dates in the
# past, because a model answering "Wednesday at 4pm" against 2023-07-27 (a
# Thursday, three years gone) was resolving it silently. Freezing `now_in` keeps
# both properties: the guard stays enforced, and the pinned dates stay valid
# forever instead of expiring the moment real time passes them.
#
# Individual tests still monkeypatch `now_in` for their own scenarios; doing it
# inside the test overrides this fixture.
FROZEN_NOW = datetime(2026, 7, 23, 15, 0, tzinfo=ZoneInfo("UTC"))  # 8AM in SF


@pytest.fixture(autouse=True)
def _freeze_clock(monkeypatch):
    """Pin `now_in` for every test, in whichever city it asks about."""
    monkeypatch.setattr(
        tu, "now_in", lambda city=None: FROZEN_NOW.astimezone(ZoneInfo(data.timezone(city)))
    )
