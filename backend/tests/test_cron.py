"""Cron expressions (app/services/cron.py): the shared cases, and when expressions fire."""

import json
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app.services.cron import cron_problem, fire_times, load_timezone, next_fire

CASES = json.loads(
    (Path(__file__).parents[2] / "shared" / "cron-cases.json").read_text(encoding="utf-8")
)["cases"]
BERLIN = ZoneInfo("Europe/Berlin")


@pytest.mark.parametrize("case", CASES, ids=[c["expression"] for c in CASES])
def test_shared_cases(case: dict) -> None:
    assert cron_problem(case["expression"]) == case["problem"]
    if case["problem"] is None:  # everything we accept, cronsim can schedule
        next_fire(case["expression"], BERLIN, datetime(2026, 10, 17, tzinfo=UTC))


def times(expression: str, after: datetime, count: int = 3, zone: ZoneInfo = BERLIN) -> list[str]:
    fired = fire_times(expression, zone, after)
    return [next(fired).isoformat() for _ in range(count)]


def test_fire_times_are_in_the_schedules_timezone() -> None:
    saturday_noon = datetime(2026, 10, 17, 10, 0, tzinfo=UTC)  # 12:00 in Berlin
    assert times("0 9 * * mon-fri", saturday_noon) == [
        "2026-10-19T09:00:00+02:00",
        "2026-10-20T09:00:00+02:00",
        "2026-10-21T09:00:00+02:00",
    ]
    assert next_fire("0 9 * * *", BERLIN, saturday_noon) == datetime(2026, 10, 18, 7, tzinfo=UTC)
    # Strictly after: an expression firing right now fires next time, not again.
    assert times("*/15 * * * *", datetime(2026, 10, 17, 10, 15, 30, tzinfo=UTC), 2) == [
        "2026-10-17T12:30:00+02:00",
        "2026-10-17T12:45:00+02:00",
    ]


def test_daylight_saving_changes() -> None:
    # 29 March 2026: 02:00 → 03:00 in Berlin, so 02:30 doesn't exist and runs at 03:00 instead.
    assert times("30 2 * * *", datetime(2026, 3, 28, 12, tzinfo=BERLIN)) == [
        "2026-03-29T03:00:00+02:00",
        "2026-03-30T02:30:00+02:00",
        "2026-03-31T02:30:00+02:00",
    ]
    # 25 October 2026: 03:00 → 02:00, so 02:30 happens twice — it runs once.
    assert times("30 2 * * *", datetime(2026, 10, 24, 12, tzinfo=BERLIN), 2) == [
        "2026-10-25T02:30:00+02:00",
        "2026-10-26T02:30:00+01:00",
    ]


def test_timezones() -> None:
    assert load_timezone("") == ZoneInfo("UTC")
    assert load_timezone(" Asia/Kolkata ") == ZoneInfo("Asia/Kolkata")
    assert load_timezone("Mars/Olympus") is None
    assert load_timezone("../etc/passwd") is None
