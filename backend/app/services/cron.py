"""Cron expressions for the Schedule trigger: checking them, and when they fire.

Mesh accepts classic 5-part cron — minute, hour, day of the month, month, day of the week — with
`*`, numbers, `a-b` ranges, `/n` steps, `,` lists and three-letter month / weekday names (0 and 7
are Sunday). No macros (`@daily`) or extensions (`L`, `#`): `cron_problem` is mirrored by the
editor (`frontend/src/lib/cron.ts`; both run `shared/cron-cases.json`), so the two must accept
exactly the same expressions. When an expression fires is left to `cronsim`, which follows cron's
rules: day of month and day of week are alternatives when both are restricted, and around DST
changes a skipped time runs at the next existing minute and a repeated one runs once.
"""

import re
from collections.abc import Iterator
from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from cronsim import CronSim

MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

#: (name, lowest, highest, names for lowest, lowest + 1, …)
_PARTS: list[tuple[str, int, int, list[str]]] = [
    ("minute", 0, 59, []),
    ("hour", 0, 23, []),
    ("day of the month", 1, 31, []),
    ("month", 1, 12, MONTHS),
    ("day of the week", 0, 7, WEEKDAYS),
]
_ITEM = re.compile(r"^(?:\*|(\w+)(?:-(\w+))?)(?:/(\d+))?$")
_ASCII_DIGITS = re.compile(r"^[0-9]+$")

WRONG_LENGTH = "must have 5 parts: minute, hour, day of the month, month and day of the week"


def _value(token: str, low: int, high: int, names: list[str]) -> int | None:
    if _ASCII_DIGITS.match(token):
        number = int(token)
        return number if low <= number <= high else None
    name = token.lower()
    return low + names.index(name) if name in names else None


def _valid_part(part: str, low: int, high: int, names: list[str]) -> bool:
    for item in part.split(","):
        match = _ITEM.match(item)
        if not match:
            return False
        start, end, step = match.groups()
        if step is not None and not 1 <= int(step) <= high:
            return False
        if start is None:
            continue  # *
        first = _value(start, low, high, names)
        if first is None:
            return False
        if end is not None:
            last = _value(end, low, high, names)
            if last is None or last < first:
                return False
    return True


def cron_problem(expression: str) -> str | None:
    """What's wrong with the expression (completes "Cron expression …"), or None."""
    parts = expression.split()
    if len(parts) != len(_PARTS):
        return WRONG_LENGTH
    for part, (name, low, high, names) in zip(parts, _PARTS, strict=True):
        if not _valid_part(part, low, high, names):
            return f"has an invalid {name}: “{part}”"
    return None


def load_timezone(name: str) -> ZoneInfo | None:
    """The IANA timezone (empty → UTC), or None when there's no such zone."""
    name = name.strip() or "UTC"
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return None


def fire_times(expression: str, timezone: ZoneInfo, after: datetime) -> Iterator[datetime]:
    """When a valid expression fires, strictly after `after`, as aware datetimes in `timezone`."""
    start = after.astimezone(timezone).replace(second=0, microsecond=0)
    return CronSim(" ".join(expression.split()), start)


def next_fire(expression: str, timezone: ZoneInfo, after: datetime) -> datetime:
    return next(fire_times(expression, timezone, after)).astimezone(UTC)
