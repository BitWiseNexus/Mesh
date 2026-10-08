"""Live runs: background execution, event logs for streaming, cancellation.

A run executes as an asyncio task in this process. Its events go to
- a `RunEventLog`, replayed to every stream that connects (late joiners and reconnects with
  `Last-Event-ID` get what they missed), kept for a while after the run finishes; and
- a `RunRecorder`, which persists status transitions and outputs to Firestore.

Runs live in this process only, so the backend must run as a single instance until execution
moves to a worker queue. A run left `running` in Firestore by a crash or restart is reported as
interrupted (see RunRepository.get).
"""

import asyncio
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from app.core.config import Settings
from app.engine import events
from app.engine.compiler import ExecutionPlan
from app.engine.context import Secrets
from app.engine.events import RunEvent
from app.engine.runner import Runner
from app.repositories.runs import RunRecorder, RunRepository

logger = logging.getLogger(__name__)

#: Seconds between keep-alive pings on an idle stream (proxies drop silent connections).
KEEPALIVE_SECONDS = 15.0
#: How long stopping a run waits for its cancellation to be recorded.
CANCEL_WAIT_SECONDS = 10.0


class RunEventLog:
    """The events of one run, in order, with `seq` numbers (1, 2, …)."""

    def __init__(self) -> None:
        self.events: list[RunEvent] = []
        self.closed = False
        self._changed = asyncio.Event()

    def publish(self, event: RunEvent) -> None:
        self.events.append({**event, "seq": len(self.events) + 1})
        self._wake()

    def close(self) -> None:
        self.closed = True
        self._wake()

    def _wake(self) -> None:
        changed, self._changed = self._changed, asyncio.Event()
        changed.set()

    async def follow(
        self, after: int = 0, keepalive: float = KEEPALIVE_SECONDS
    ) -> AsyncIterator[RunEvent | None]:
        """Events with `seq > after`, then new ones as they happen, until the log closes. Yields
        None after `keepalive` seconds without events."""
        position = max(after, 0)
        while True:
            changed = self._changed  # before checking, so a publish in between isn't missed
            while position < len(self.events):
                position += 1
                yield self.events[position - 1]
            if self.closed:
                return
            try:
                await asyncio.wait_for(changed.wait(), keepalive)
            except TimeoutError:
                yield None


@dataclass
class LiveRun:
    run_id: str
    owner_uid: str
    log: RunEventLog
    #: The runner itself (cancelled by Stop).
    runner_task: asyncio.Task | None = None
    #: Runner + persistence flush; done once the run is fully recorded.
    task: asyncio.Task | None = None
    finished: bool = field(default=False)


class RunManager:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._live: dict[str, LiveRun] = {}

    def get(self, run_id: str) -> LiveRun | None:
        return self._live.get(run_id)

    def is_live(self, run_id: str) -> bool:
        return run_id in self._live

    def active_runs(self, owner_uid: str) -> int:
        return sum(1 for r in self._live.values() if r.owner_uid == owner_uid and not r.finished)

    def start(
        self,
        *,
        run_id: str,
        owner_uid: str,
        plan: ExecutionPlan,
        input: str | None,
        repository: RunRepository,
        secrets: Secrets | None = None,
    ) -> LiveRun:
        live = LiveRun(run_id=run_id, owner_uid=owner_uid, log=RunEventLog())
        recorder = RunRecorder(repository, run_id)

        def sink(event: RunEvent) -> None:
            live.log.publish(event)
            recorder.record(event)

        runner = Runner(
            plan,
            run_id=run_id,
            input=input,
            sink=sink,
            timeout=self.settings.run_timeout_seconds,
            secrets=secrets,
        )

        live.runner_task = asyncio.create_task(runner.run(), name=f"run:{run_id}")

        async def execute() -> None:
            try:
                await live.runner_task
            except Exception:  # Runner.run reports failures itself; this is a bug
                logger.exception("Run %s crashed", run_id)
                sink(events.run_finished("failed", "Internal error while running the flow"))
            finally:
                live.finished = True
                await recorder.close()
                live.log.close()
                self._forget_later(run_id)

        live.task = asyncio.create_task(execute(), name=f"run-main:{run_id}")
        self._live[run_id] = live
        return live

    def _forget_later(self, run_id: str) -> None:
        delay = self.settings.run_events_retention_seconds
        asyncio.get_running_loop().call_later(delay, self._live.pop, run_id, None)

    async def cancel(self, run_id: str) -> None:
        """Stops a live run and waits (up to CANCEL_WAIT_SECONDS) until it is recorded."""
        live = self._live.get(run_id)
        if live is None or live.task is None:
            return
        if not live.finished and live.runner_task is not None:
            live.runner_task.cancel()
        await asyncio.wait([live.task], timeout=CANCEL_WAIT_SECONDS)

    async def shutdown(self) -> None:
        """Cancels every live run (server stopping) and waits for them to be recorded."""
        await asyncio.gather(*(self.cancel(run_id) for run_id in list(self._live)))
