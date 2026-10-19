"""A flow's schedules, for the editor: `GET /flows/{flow_id}/schedules`; and `GET /timezones`, the
timezones a Schedule trigger accepts (the editor's suggestions — browsers' lists differ: Chromium
says Asia/Calcutta where tzdata also has Asia/Kolkata).

One entry per Schedule trigger of the flow as last saved: whether it's active, its next times (or
why it isn't scheduled) and what happened the last time it was due. Schedules themselves are
created and updated by saving the flow (app/services/schedules.py).
"""

import zoneinfo
from datetime import UTC, datetime
from functools import cache
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.flows import FlowId
from app.api.flows import Repo as FlowRepo
from app.core.auth import CurrentUser
from app.core.firebase import get_db
from app.repositories.schedules import ScheduleRepository
from app.services.cron import fire_times, load_timezone

router = APIRouter(tags=["schedules"])

UPCOMING = 3


def get_schedule_repository() -> ScheduleRepository:
    return ScheduleRepository(get_db())


Schedules = Annotated[ScheduleRepository, Depends(get_schedule_repository)]


class ScheduleInfo(BaseModel):
    node_id: str
    cron: str
    timezone: str
    enabled: bool
    #: The next few times it fires, in UTC (empty when it's off or has a problem).
    next_runs: list[datetime]
    #: Why it isn't scheduled although it's switched on.
    problem: str | None = None
    last_fired_at: datetime | None = None
    last_run_id: str | None = None
    last_error: str | None = None


@router.get("/flows/{flow_id}/schedules")
async def list_schedules(
    flow_id: FlowId, user: CurrentUser, flows: FlowRepo, schedules: Schedules
) -> list[ScheduleInfo]:
    await flows.get(user.uid, flow_id)  # 404 unless it's the caller's flow
    result = []
    for s in await schedules.list_for_flow(user.uid, flow_id):
        next_runs = []
        zone = load_timezone(s.timezone)
        if s.next_run_at is not None and zone is not None:
            later = fire_times(s.cron, zone, s.next_run_at)
            upcoming = [s.next_run_at, *(next(later) for _ in range(UPCOMING - 1))]
            next_runs = [t.astimezone(UTC) for t in upcoming]
        result.append(
            ScheduleInfo(
                node_id=s.node_id,
                cron=s.cron,
                timezone=s.timezone,
                enabled=s.enabled,
                next_runs=next_runs,
                problem=s.problem,
                last_fired_at=s.last_fired_at,
                last_run_id=s.last_run_id,
                last_error=s.last_error,
            )
        )
    return result


@cache
def _timezones() -> list[str]:
    # Area/Location names (both current and older spellings); legacy one-word aliases such as
    # "Japan" or "EST5EDT" still work when typed but aren't suggested.
    names = (z for z in zoneinfo.available_timezones() if "/" in z and not z.startswith("Etc/"))
    return ["UTC", *sorted(names)]


@router.get("/timezones")
async def list_timezones() -> list[str]:
    """Every timezone suggested for Schedule triggers: UTC first, then by name."""
    return _timezones()
