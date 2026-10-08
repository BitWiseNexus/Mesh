"""The async graph runner: executes an ExecutionPlan (contract: context.md §8k).

- A step starts once every one of its inputs has delivered or been skipped. If all were skipped
  it is skipped too, and its outputs skip in turn — so untaken branches can re-join safely.
- Ready steps run concurrently (one asyncio task each).
- A finished step delivers on the handles its executor chose and skips its other outputs.
- The first failure fails the run: steps still running are cancelled, pending ones never start.
- `asyncio` cancellation of `run()` (e.g. the user pressed Stop) cancels the running steps and
  finishes the run as `cancelled`; exceeding `timeout` finishes it as `failed`.

Every transition is reported to the event sink (see app/engine/events.py).
"""

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from app.engine import events
from app.engine.compiler import ExecutionPlan, PlanEdge
from app.engine.context import RunContext, Secrets
from app.engine.events import EventSink, NodeStatus, RunStatus
from app.engine.executor import Executor, NodeError, NodeResult, get_executor

logger = logging.getLogger(__name__)


@dataclass
class RunOutcome:
    status: RunStatus
    error: str | None = None
    statuses: dict[str, NodeStatus] = field(default_factory=dict)
    outputs: dict[str, Any] = field(default_factory=dict)


class _StepFailed(Exception):
    def __init__(self, node_id: str, message: str) -> None:
        super().__init__(message)
        self.node_id = node_id
        self.message = message


class Runner:
    def __init__(
        self,
        plan: ExecutionPlan,
        *,
        run_id: str,
        input: str | None,
        sink: EventSink,
        timeout: float | None = None,
        executors: dict[Any, Executor] | None = None,
        secrets: Secrets | None = None,
    ) -> None:
        self.plan = plan
        self.ctx = RunContext(plan, run_id=run_id, input=input, sink=sink, secrets=secrets)
        self.sink = sink
        self.timeout = timeout
        #: Overrides for tests; otherwise the registry.
        self._executors = executors
        self.statuses: dict[str, NodeStatus] = {n.id: "pending" for n in plan.steps}
        self._settled: dict[str, int] = {n.id: 0 for n in plan.steps}
        self._ready: list[str] = []
        self._running: dict[asyncio.Task[NodeResult], str] = {}

    # ── public ────────────────────────────────────────────────────────────

    async def run(self) -> RunOutcome:
        self.sink(events.run_started(self.ctx.run_id, self.plan.trigger_id))
        status: RunStatus = "succeeded"
        error: str | None = None
        try:
            async with asyncio.timeout(self.timeout):
                await self._schedule()
        except _StepFailed as failure:
            status, error = "failed", f"“{self.plan.node(failure.node_id).name}” failed: {failure}"
        except TimeoutError:
            status, error = "failed", f"The run took longer than {self.timeout:g} s and was stopped"
        except asyncio.CancelledError:
            status, error = "cancelled", None
            # The run was stopped on purpose; finish it cleanly instead of propagating.
            if (task := asyncio.current_task()) is not None:
                task.uncancel()
        finally:
            await self._cancel_running()
        self.sink(events.run_finished(status, error))
        return RunOutcome(status, error, dict(self.statuses), dict(self.ctx.outputs))

    # ── scheduling ────────────────────────────────────────────────────────

    async def _schedule(self) -> None:
        self._ready.append(self.plan.trigger_id)
        while True:
            while self._ready:
                self._start(self._ready.pop(0))
            if not self._running:
                return
            done, _ = await asyncio.wait(self._running, return_when=asyncio.FIRST_COMPLETED)
            # Record every finished step (in canvas order, for deterministic runs) before acting
            # on a failure, so none of them is reported as cancelled.
            order = list(self.statuses)
            failure: _StepFailed | None = None
            for task in sorted(done, key=lambda t: order.index(self._running[t])):
                failed = self._finish(self._running.pop(task), task)
                failure = failure or failed
            if failure:
                raise failure

    def _executor(self, node_id: str) -> Executor:
        node_type = self.plan.node(node_id).type
        found = (
            self._executors.get(node_type)
            if self._executors is not None
            else get_executor(node_type)
        )
        if found is None:  # the API refuses such runs up front (not_runnable_issues)
            raise RuntimeError(f"No executor for {node_type}")
        return found

    def _start(self, node_id: str) -> None:
        self.statuses[node_id] = "running"
        self.sink(events.node_started(node_id))
        run = self._executor(node_id)
        task = asyncio.create_task(run(self.ctx.node(node_id)), name=f"node:{node_id}")
        self._running[task] = node_id

    def _finish(self, node_id: str, task: asyncio.Task[NodeResult]) -> "_StepFailed | None":
        """Records a finished step and settles its outputs; returns its failure, if any."""
        node = self.plan.node(node_id)
        try:
            result = task.result()
            if not isinstance(result, NodeResult):
                raise TypeError(f"executor returned {type(result).__name__}, not NodeResult")
            handles = list(node.outputs) if result.handles is None else list(result.handles)
            if unknown := [h for h in handles if h not in node.outputs]:
                raise ValueError(f"executor chose unknown output handles {unknown}")
        except NodeError as exc:
            return self._fail(node_id, str(exc))
        except Exception as exc:
            logger.exception("Node %s (%s) crashed", node_id, node.type)
            return self._fail(node_id, f"Unexpected error: {type(exc).__name__}: {exc}")

        self.statuses[node_id] = "succeeded"
        self.ctx.outputs[node_id] = result.output
        self.sink(events.node_finished(node_id, "succeeded", output=result.output, handles=handles))
        for handle, edges in node.outputs.items():
            for edge in edges:
                self._settle(edge, delivered=handle in handles)
        return None

    def _fail(self, node_id: str, message: str) -> _StepFailed:
        self.statuses[node_id] = "failed"
        self.sink(events.node_finished(node_id, "failed", error=message))
        return _StepFailed(node_id, message)

    def _settle(self, edge: PlanEdge, *, delivered: bool) -> None:
        target = edge.target
        if delivered:
            self.ctx.delivered.setdefault(target, []).append(edge)
        self._settled[target] += 1
        if self._settled[target] < len(self.plan.node(target).inputs):
            return
        if self.ctx.delivered.get(target):
            self._ready.append(target)
        else:
            self._skip(target)

    def _skip(self, node_id: str) -> None:
        self.statuses[node_id] = "skipped"
        self.sink(events.node_finished(node_id, "skipped"))
        for edges in self.plan.node(node_id).outputs.values():
            for edge in edges:
                self._settle(edge, delivered=False)

    async def _cancel_running(self) -> None:
        if not self._running:
            return
        for task in self._running:
            task.cancel()
        await asyncio.gather(*self._running, return_exceptions=True)
        for node_id in self._running.values():
            self.statuses[node_id] = "cancelled"
            self.sink(events.node_finished(node_id, "cancelled"))
        self._running.clear()
