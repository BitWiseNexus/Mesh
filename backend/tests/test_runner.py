"""The async runner (app/engine/runner.py) with fake and real executors."""

import asyncio
import time
from typing import Any

from app.engine.compiler import compile_flow
from app.engine.context import NodeContext
from app.engine.executor import NodeError, NodeResult, get_executor
from app.engine.runner import Runner, RunOutcome
from app.schemas.node_types import NodeType
from tests.flows import edge, flow, node

T = NodeType


class Recorder:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def __call__(self, event: dict[str, Any]) -> None:
        self.events.append(event)

    def types(self, node_id: str | None = None) -> list[str]:
        return [e["type"] for e in self.events if node_id is None or e.get("node_id") == node_id]

    def finished(self) -> dict[str, str]:
        return {e["node_id"]: e["status"] for e in self.events if e["type"] == "node_finished"}


def real(*types: NodeType) -> dict[NodeType, Any]:
    return {t: get_executor(t) for t in types}


async def passthrough(ctx: NodeContext) -> NodeResult:
    return NodeResult(ctx.input)


def run(plan_flow, *, executors=None, input=None, timeout=None, trigger=None):
    sink = Recorder()
    plan = compile_flow(plan_flow, trigger)
    runner = Runner(plan, run_id="r1", input=input, sink=sink, timeout=timeout, executors=executors)
    return asyncio.run(runner.run()), sink


def test_manual_trigger_to_agent_to_output() -> None:
    f = flow(
        [
            node("t", "trigger_manual", "trigger", input="default text"),
            node("a", "agent_node", "agent", model="mock/echo", prompt="Say: {{input}}"),
            node("out", "output_display", "result"),
        ],
        [edge("t", "a"), edge("a", "out")],
    )
    outcome, sink = run(f, input="hello world")
    assert outcome == RunOutcome(
        "succeeded",
        statuses={"t": "succeeded", "a": "succeeded", "out": "succeeded"},
        outputs={"t": "hello world", "a": "Say: hello world", "out": "Say: hello world"},
    )
    assert sink.types()[0] == "run_started" and sink.types()[-1] == "run_finished"
    assert sink.events[-1]["status"] == "succeeded"
    tokens = [e["text"] for e in sink.events if e["type"] == "token"]
    assert "".join(tokens) == "Say: hello world" and len(tokens) == 3
    assert sink.types("a") == ["node_started", "token", "token", "token", "node_finished"]
    assert all(e["at"] for e in sink.events)


def test_trigger_uses_its_default_input_without_run_input() -> None:
    f = flow([node("t", "trigger_manual", input="default text")], [])
    outcome, _ = run(f)
    assert outcome.outputs == {"t": "default text"}


def test_independent_branches_run_concurrently_and_join_by_ref() -> None:
    async def slow(ctx: NodeContext) -> NodeResult:
        await asyncio.sleep(0.2)
        return NodeResult(f"{ctx.node.ref} done")

    f = flow(
        [
            node("t", "trigger_manual"),
            node("a", "agent_node", "left"),
            node("b", "agent_node", "right"),
            node("out", "output_display"),
        ],
        [edge("t", "a"), edge("t", "b"), edge("a", "out"), edge("b", "out")],
    )
    started = time.perf_counter()
    outcome, _ = run(
        f,
        executors={**real(T.TRIGGER_MANUAL, T.OUTPUT_DISPLAY), T.AGENT_NODE: slow},
    )
    assert time.perf_counter() - started < 0.35  # not 0.4: both slept at once
    assert outcome.outputs["out"] == {"left": "left done", "right": "right done"}


BRANCHY = flow(
    [
        node("t", "trigger_manual"),
        node("if", "logic_if", "check", value="x"),
        node("yes", "agent_node"),
        node("no", "agent_node"),
        node("after_no", "output_display"),
        node("join", "output_display"),
    ],
    [
        edge("t", "if"),
        edge("if", "yes", "true"),
        edge("if", "no", "false"),
        edge("no", "after_no"),
        edge("yes", "join"),
        edge("no", "join"),
    ],
)


def _branch(handle: str):
    async def choose(ctx: NodeContext) -> NodeResult:
        return NodeResult(ctx.input, handles=(handle,))

    return choose


def test_untaken_branches_are_skipped_and_rejoin() -> None:
    executors = {**real(T.TRIGGER_MANUAL), T.OUTPUT_DISPLAY: passthrough, T.AGENT_NODE: passthrough}
    outcome, sink = run(BRANCHY, executors={**executors, T.LOGIC_IF: _branch("true")}, input="hi")
    assert outcome.status == "succeeded"
    assert outcome.statuses == {
        "t": "succeeded",
        "if": "succeeded",
        "yes": "succeeded",
        "no": "skipped",
        "after_no": "skipped",  # skips propagate
        "join": "succeeded",  # one input delivered, one skipped
    }
    assert outcome.outputs["join"] == "hi"  # a single delivered input is passed as-is
    finished_if = next(e for e in sink.events if e.get("node_id") == "if" and "handles" in e)
    assert finished_if["handles"] == ["true"]


def test_a_node_whose_inputs_were_all_skipped_is_skipped() -> None:
    executors = {**real(T.TRIGGER_MANUAL), T.OUTPUT_DISPLAY: passthrough, T.AGENT_NODE: passthrough}
    outcome, _ = run(BRANCHY, executors={**executors, T.LOGIC_IF: _branch_none()})
    assert {k: v for k, v in outcome.statuses.items() if k != "t" and k != "if"} == {
        "yes": "skipped",
        "no": "skipped",
        "after_no": "skipped",
        "join": "skipped",
    }


def _branch_none():
    async def neither(ctx: NodeContext) -> NodeResult:
        return NodeResult(None, handles=())

    return neither


def test_a_failure_fails_the_run_and_cancels_running_steps() -> None:
    cancelled = asyncio.Event()

    async def fail(ctx: NodeContext) -> NodeResult:
        await asyncio.sleep(0.05)
        raise NodeError("the model is down")

    async def hang(ctx: NodeContext) -> NodeResult:
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled.set()
            raise
        return NodeResult()

    f = flow(
        [
            node("t", "trigger_manual"),
            node("bad", "agent_node", label="Writer"),
            node("slow", "logic_if"),
            node("after", "output_display"),
        ],
        [edge("t", "bad"), edge("t", "slow"), edge("bad", "after")],
    )
    outcome, sink = run(
        f,
        executors={
            **real(T.TRIGGER_MANUAL, T.OUTPUT_DISPLAY),
            T.AGENT_NODE: fail,
            T.LOGIC_IF: hang,
        },
    )
    assert outcome.status == "failed"
    assert outcome.error == "“Writer” failed: the model is down"
    assert outcome.statuses == {
        "t": "succeeded",
        "bad": "failed",
        "slow": "cancelled",
        "after": "pending",  # never started
    }
    assert cancelled.is_set()
    failed = next(e for e in sink.events if e.get("status") == "failed" and "node_id" in e)
    assert failed["error"] == "the model is down" and "output" not in failed
    assert sink.events[-1] == {**sink.events[-1], "status": "failed", "error": outcome.error}


def test_simultaneous_failures_are_all_reported() -> None:
    async def fail(ctx: NodeContext) -> NodeResult:
        raise NodeError(f"{ctx.node.id} broke")

    f = flow(
        [node("t", "trigger_manual"), node("a", "agent_node"), node("b", "agent_node")],
        [edge("t", "a"), edge("t", "b")],
    )
    outcome, _ = run(f, executors={**real(T.TRIGGER_MANUAL), T.AGENT_NODE: fail})
    assert outcome.statuses == {"t": "succeeded", "a": "failed", "b": "failed"}
    assert outcome.error == "“Agent” failed: a broke"  # the first in canvas order


def test_crashing_executors_and_bad_results_fail_the_node() -> None:
    async def crash(ctx: NodeContext) -> NodeResult:
        raise RuntimeError("boom")

    async def wrong_handle(ctx: NodeContext) -> NodeResult:
        return NodeResult("x", handles=("sideways",))

    f = flow([node("t", "trigger_manual"), node("a", "agent_node")], [edge("t", "a")])
    trigger = real(T.TRIGGER_MANUAL)
    outcome, _ = run(f, executors={**trigger, T.AGENT_NODE: crash})
    assert outcome.error == "“Agent” failed: Unexpected error: RuntimeError: boom"
    outcome, _ = run(f, executors={**trigger, T.AGENT_NODE: wrong_handle})
    assert "unknown output handles ['sideways']" in (outcome.error or "")


def test_cancelling_the_run_cancels_running_steps() -> None:
    started = asyncio.Event()

    async def hang(ctx: NodeContext) -> NodeResult:
        started.set()
        await asyncio.sleep(10)
        return NodeResult()

    f = flow([node("t", "trigger_manual"), node("a", "agent_node")], [edge("t", "a")])
    sink = Recorder()
    runner = Runner(
        compile_flow(f),
        run_id="r1",
        input=None,
        sink=sink,
        executors={**real(T.TRIGGER_MANUAL), T.AGENT_NODE: hang},
    )

    async def main() -> RunOutcome:
        task = asyncio.create_task(runner.run())
        await started.wait()
        task.cancel()
        return await task  # finishes normally, as "cancelled"

    outcome = asyncio.run(main())
    assert outcome.status == "cancelled" and outcome.error is None
    assert sink.finished() == {"t": "succeeded", "a": "cancelled"}
    assert sink.events[-1]["type"] == "run_finished" and sink.events[-1]["status"] == "cancelled"


def test_runs_that_take_too_long_fail() -> None:
    async def hang(ctx: NodeContext) -> NodeResult:
        await asyncio.sleep(10)
        return NodeResult()

    f = flow([node("t", "trigger_manual"), node("a", "agent_node")], [edge("t", "a")])
    outcome, _ = run(f, executors={**real(T.TRIGGER_MANUAL), T.AGENT_NODE: hang}, timeout=0.05)
    assert outcome.status == "failed"
    assert outcome.error == "The run took longer than 0.05 s and was stopped"
    assert outcome.statuses["a"] == "cancelled"


def test_only_the_chosen_triggers_branch_runs() -> None:
    f = flow(
        [
            node("t1", "trigger_manual", input="one"),
            node("t2", "trigger_manual", input="two"),
            node("out", "output_display"),
        ],
        [edge("t1", "out"), edge("t2", "out")],
    )
    outcome, _ = run(f, executors=real(T.TRIGGER_MANUAL, T.OUTPUT_DISPLAY), trigger="t2")
    assert outcome.outputs == {"t2": "two", "out": "two"}
    assert outcome.statuses == {"t2": "succeeded", "out": "succeeded"}
