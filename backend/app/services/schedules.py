"""Schedule triggers: keeping `schedules` in step with saved flows, and firing them.

- `sync_schedules` runs whenever a flow is saved (created, replaced, duplicated): each Schedule
  trigger gets a schedule that is active (has `next_run_at`) when it's switched on, its cron
  expression and timezone are valid and the flow can run from it — otherwise it records why not
  (`problem`), which the editor shows next to the trigger.
- `Scheduler` (one per process, `app.state.scheduler`) wakes at the start of every minute, claims
  the schedules that are due and starts their runs like the Run button does — as the flow's owner,
  with the trigger's output `{scheduled_at, timezone}` as input. A time more than
  `schedule_grace_seconds` in the past (the server wasn't running) is skipped, not caught up: a
  backlog of runs after downtime would be worse than a gap, and the skip is recorded.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from app.core.config import Settings
from app.core.errors import ApiError
from app.core.firebase import get_db
from app.engine.compiler import compile_flow
from app.engine.executor import not_runnable_issues
from app.engine.graph import with_field_defaults
from app.repositories.flows import FlowNotFoundError, FlowRepository
from app.repositories.runs import RunRepository
from app.repositories.schedules import Schedule, ScheduleRepository
from app.schemas.flow import Node
from app.schemas.flows_api import StoredFlow
from app.schemas.node_types import NodeType
from app.services.cron import cron_problem, load_timezone, next_fire
from app.services.ingestion import IngestionManager
from app.services.launch import launch_run
from app.services.runs import RunManager

logger = logging.getLogger(__name__)

FLOW_PROBLEMS = "The flow has problems — fix them in the editor to start this schedule."


def _runnable_from(flow: StoredFlow, trigger_id: str) -> bool:
    try:
        return not not_runnable_issues(compile_flow(flow, trigger_id))
    except ApiError:
        return False


def wanted_schedules(owner_uid: str, flow: StoredFlow, now: datetime) -> list[dict[str, Any]]:
    """The schedules `flow`'s Schedule triggers ask for (see `ScheduleRepository`)."""
    wanted = []
    for node in flow.nodes:
        if node.type is not NodeType.TRIGGER_CRON:
            continue
        data = with_field_defaults(node.type, node.data)
        cron = str(data.get("cron") or "").strip()
        timezone = str(data.get("timezone") or "").strip() or "UTC"
        enabled = data.get("enabled") is not False
        zone = load_timezone(timezone)
        problem: str | None = None
        next_run_at = None
        if enabled:
            if bad := cron_problem(cron):
                problem = f"The cron expression {bad}."
            elif zone is None:
                problem = f"“{timezone}” isn't a timezone (e.g. UTC or Europe/Berlin)."
            elif not _runnable_from(flow, node.id):
                problem = FLOW_PROBLEMS
            else:
                next_run_at = next_fire(cron, zone, now)
        wanted.append(
            {
                "owner_uid": owner_uid,
                "flow_id": flow.flow_id,
                "node_id": node.id,
                "cron": cron,
                "timezone": timezone,
                "enabled": enabled,
                "problem": problem,
                "next_run_at": next_run_at,
            }
        )
    return wanted


async def sync_schedules(
    repository: ScheduleRepository, owner_uid: str, flow: StoredFlow, now: datetime | None = None
) -> None:
    wanted = wanted_schedules(owner_uid, flow, now or datetime.now(UTC))
    await repository.replace_for_flow(flow.flow_id, wanted)


def paused(nodes: list[Node]) -> list[Node]:
    """`nodes` with every Schedule trigger switched off — copies of a flow don't start running on
    their own next to the original."""
    return [
        n.model_copy(update={"data": {**n.data, "enabled": False}})
        if n.type is NodeType.TRIGGER_CRON
        else n
        for n in nodes
    ]


def _when(moment: datetime, timezone: str) -> str:
    zone = load_timezone(timezone) or UTC
    return f"{moment.astimezone(zone):%Y-%m-%d %H:%M} ({timezone})"


class Scheduler:
    def __init__(
        self,
        settings: Settings,
        runs: RunManager,
        ingestion: IngestionManager,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.settings = settings
        self.runs = runs
        self.ingestion = ingestion
        self.clock = clock
        self.sleep = sleep
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop(), name="scheduler")

    async def shutdown(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    async def _loop(self) -> None:
        while True:
            try:
                async with asyncio.timeout(50):
                    await self.tick()
            except Exception as exc:
                logger.warning("Scheduler: couldn't check the schedules: %r", exc)
            now = self.clock()  # wake half a second into the next minute
            await self.sleep(60 - now.second - now.microsecond / 1e6 + 0.5)

    async def tick(self, now: datetime | None = None) -> list[str]:
        """Starts the runs of every schedule due at `now`; returns their run ids."""
        now = now or self.clock()
        db = get_db()
        schedules = ScheduleRepository(db)
        started = []
        for schedule in await schedules.due(now):
            try:
                run_id = await self._fire(schedule, now, schedules, db)
            except Exception:  # e.g. the database hiccuped: the others still get their turn
                logger.exception("Schedule %s: couldn't be checked", schedule.id)
                continue
            if run_id is not None:
                started.append(run_id)
        return started

    async def _fire(
        self, schedule: Schedule, now: datetime, schedules: ScheduleRepository, db: Any
    ) -> str | None:
        due_at = schedule.next_run_at
        zone = load_timezone(schedule.timezone)
        if due_at is None or zone is None or cron_problem(schedule.cron):
            return None  # not something `sync` would have scheduled
        if not await schedules.claim(schedule.id, due_at, next_fire(schedule.cron, zone, now)):
            return None
        when = _when(due_at, schedule.timezone)
        if (now - due_at).total_seconds() > self.settings.schedule_grace_seconds:
            logger.info("Schedule %s: skipped %s (missed)", schedule.id, when)
            await schedules.record(
                schedule.id, {"last_error": f"Skipped {when}: the server wasn't running then."}
            )
            return None
        try:
            owner_uid, flow = await FlowRepository(db).get_with_owner(schedule.flow_id)
            trigger = next((n for n in flow.nodes if n.id == schedule.node_id), None)
            if owner_uid != schedule.owner_uid or trigger is None:
                raise FlowNotFoundError()
            info = await launch_run(
                owner_uid=owner_uid,
                stored=flow,
                plan=compile_flow(flow, schedule.node_id),
                input={"scheduled_at": due_at.astimezone(zone).isoformat(), "timezone": zone.key},
                runs=RunRepository(db),
                manager=self.runs,
                ingestion=self.ingestion,
            )
        except FlowNotFoundError:
            await schedules.delete(schedule.id)  # the flow or trigger is gone
            return None
        except ApiError as exc:
            await schedules.record(schedule.id, {"last_error": f"Didn't run {when}: {exc.message}"})
            return None
        except Exception:
            logger.exception("Schedule %s: couldn't start the run due %s", schedule.id, when)
            await schedules.record(
                schedule.id, {"last_error": f"Didn't run {when}: something went wrong."}
            )
            return None
        logger.info("Schedule %s started run %s (%s)", schedule.id, info.run_id, when)
        await schedules.record(schedule.id, {"last_run_id": info.run_id, "last_error": None})
        return info.run_id
