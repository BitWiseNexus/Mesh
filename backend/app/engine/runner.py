"""The async graph runner: executes an ExecutionPlan (contract: context.md §8k).

- A step starts once every one of its inputs has delivered or been skipped. If all were skipped
  it is skipped too, and its outputs skip in turn — so untaken branches can re-join safely.
- Ready steps run concurrently (one asyncio task each).
- A finished step delivers on the handles its executor chose and skips its other outputs.
- Loops (context.md §8q): a Loop starts on its entry inputs and delivers on `loop`; its body (see
  PlannedNode.loop_body) runs; when the edges back into the Loop have settled, the Loop decides
  again — `loop` (the body is reset and runs once more) or `done`. Unlike other branches, the
  path a Loop doesn't take isn't skipped: `done` only fires at the end, and choosing `done`
  doesn't skip the body that just ran. A body that doesn't come back ends the loop.
- The first failure fails the run: steps still running are cancelled, pending ones never start.
  So does running more than MAX_NODE_RUNS steps (runaway loops).
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
from app.schemas.node_types import NodeType

logger = logging.getLogger(__name__)

#: Upper bound on step executions per run (nested loops multiply quickly).
MAX_NODE_RUNS = 10_000


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


class _RunFailed(Exception):
    """The run as a whole can't go on (not one node's fault)."""


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
        #: Edge id → delivered (True) or skipped (False); absent = not settled yet.
        self._edges: dict[str, bool] = {}
        self._ready: list[str] = []
        self._running: dict[asyncio.Task[NodeResult], str] = {}
        self._runs = 0
        loops = [n for n in plan.steps if n.type is NodeType.LOGIC_LOOP]
        #: Loops that started and wait for their body to come back.
        self._awaiting_body: set[str] = set()
        #: Each node's innermost enclosing loop (the smallest body containing it).
        self._loop_of: dict[str, str] = {}
        for loop in sorted(loops, key=lambda n: len(n.loop_body), reverse=True):
            for member in loop.loop_body:
                self._loop_of[member] = loop.id

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
        except _RunFailed as failure:
            status, error = "failed", str(failure)
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

    def _iteration(self, node_id: str) -> int | None:
        """The iteration (1, 2, …) of the innermost loop around `node_id`, if any."""
        loop = self._loop_of.get(node_id)
        return self.ctx.iterations.get(loop, 0) if loop else None

    def _start(self, node_id: str) -> None:
        self._runs += 1
        if self._runs > MAX_NODE_RUNS:
            raise _RunFailed(
                f"The run stopped after {MAX_NODE_RUNS} steps — check the flow's loops"
            )
        self.statuses[node_id] = "running"
        self.sink(events.node_started(node_id, iteration=self._iteration(node_id)))
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
        if node.type is NodeType.LOGIC_LOOP:
            self._continue_loop(node_id, handles)
        else:
            self._deliver(node_id, handles)
        self._after(node_id)
        return None

    def _deliver(self, node_id: str, handles: list[str]) -> None:
        for handle, edges in self.plan.node(node_id).outputs.items():
            for edge in edges:
                self._settle(edge, delivered=handle in handles)

    def _continue_loop(self, loop_id: str, handles: list[str]) -> None:
        node = self.plan.node(loop_id)
        if "done" in handles:
            self._awaiting_body.discard(loop_id)
            for edge in node.outputs.get("done", ()):
                self._settle(edge, delivered=True)
            return
        # Another iteration: start the body afresh.
        self.ctx.iterations[loop_id] = self.ctx.iterations.get(loop_id, 0) + 1
        self._reset_body(loop_id)
        comes_back = any(e.back for e in node.inputs)
        if comes_back:
            self._awaiting_body.add(loop_id)
        for edge in node.outputs.get("loop", ()):
            self._settle(edge, delivered=True)
        if not comes_back:
            # Nothing leads back (validation warns): the body runs once, and the flow goes on.
            for edge in node.outputs.get("done", ()):
                self._settle(edge, delivered=True)

    def _reset_body(self, loop_id: str) -> None:
        loop = self.plan.node(loop_id)
        body = loop.loop_body
        for member in body:
            self.statuses[member] = "pending"
            self.ctx.outputs.pop(member, None)
            self.ctx.delivered.pop(member, None)
            if member in self.ctx.iterations:  # a nested loop starts over too
                self.ctx.iterations[member] = 0
                self._awaiting_body.discard(member)
            for edge in self.plan.node(member).inputs:
                # Inputs from outside the loop delivered once and stay settled.
                if edge.source in body or edge.source == loop_id:
                    self._edges.pop(edge.id, None)
        for edge in loop.inputs:
            if edge.back:
                self._edges.pop(edge.id, None)

    def _awaited_inputs(self, node_id: str) -> list[PlanEdge]:
        node = self.plan.node(node_id)
        if node.type is NodeType.LOGIC_LOOP:
            back = node_id in self._awaiting_body
            return [e for e in node.inputs if e.back == back]
        return list(node.inputs)

    def _settle(self, edge: PlanEdge, *, delivered: bool) -> None:
        self._edges[edge.id] = delivered
        # A loop waiting for its body is checked once the sender has settled *all* its outputs
        # (_after): checking now could miss a side branch of the body that's about to start.
        if edge.target not in self._awaiting_body:
            self._check(edge.target)

    def _check(self, node_id: str) -> None:
        """Starts or skips `node_id` if everything it waits for has settled."""
        waiting_loop = node_id in self._awaiting_body
        if self.statuses[node_id] != "pending" and not waiting_loop:
            return  # already decided (e.g. a node fed by both a loop body and its Done output)
        awaited = self._awaited_inputs(node_id)
        if any(e.id not in self._edges for e in awaited):
            return
        if waiting_loop and self._body_busy(node_id):
            return  # rechecked when the rest of the body finishes (_after)
        arrived = [e for e in awaited if self._edges[e.id]]
        if waiting_loop:
            self._awaiting_body.discard(node_id)
            if not arrived:
                # The body took a path that doesn't come back: the loop ends here.
                self.sink(
                    events.log("The loop body didn't come back, so the loop ends", "info", node_id)
                )
                self._continue_loop(node_id, ["done"])
                return
        if arrived:
            self.ctx.delivered[node_id] = arrived
            self._ready.append(node_id)
        else:
            self._skip(node_id)

    def _body_busy(self, loop_id: str) -> bool:
        """Some of the loop's body is still running or about to (a branch that doesn't lead back
        may finish after the one that does). The next iteration waits for all of it."""
        body = self.plan.node(loop_id).loop_body
        return any(self.statuses[m] == "running" for m in body) or any(
            m in body for m in self._ready
        )

    def _after(self, node_id: str) -> None:
        """A step finished or was skipped: loops waiting on their body may be able to go on."""
        for loop_id in list(self._awaiting_body):
            if node_id in self.plan.node(loop_id).loop_body:
                self._check(loop_id)

    def _skip(self, node_id: str) -> None:
        self.statuses[node_id] = "skipped"
        self.sink(events.node_finished(node_id, "skipped"))
        for edges in self.plan.node(node_id).outputs.values():
            for edge in edges:
                self._settle(edge, delivered=False)
        self._after(node_id)

    def _fail(self, node_id: str, message: str) -> _StepFailed:
        self.statuses[node_id] = "failed"
        self.sink(events.node_finished(node_id, "failed", error=message))
        return _StepFailed(node_id, message)

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
