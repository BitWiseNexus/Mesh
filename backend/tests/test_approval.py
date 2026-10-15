"""Approval Gates: pausing a run, checkpoints, and resuming with a reviewer's decision."""

import asyncio
import json
from typing import Any

import pytest

from app.engine.compiler import compile_flow
from app.engine.context import NodeContext
from app.engine.executor import NodeError, NodeResult, get_executor
from app.engine.runner import Decision, Runner
from app.schemas.node_types import NodeType
from tests.flows import edge, flow, node

T = NodeType
REAL = (T.TRIGGER_MANUAL, T.HITL_APPROVAL, T.LOGIC_LOOP, T.OUTPUT_DISPLAY, T.LOGIC_IF)


async def exclaim(ctx: NodeContext) -> NodeResult:
    return NodeResult(f"{ctx.input}!")


def executors(**overrides: Any) -> dict:
    return {t: get_executor(t) for t in REAL} | {T.AGENT_NODE: exclaim} | overrides


def run(plan, *, checkpoint=None, decisions=None, input="draft", extra=None):
    events: list[dict] = []
    runner = Runner(
        plan,
        run_id="r",
        input=input,
        sink=events.append,
        executors=executors(**(extra or {})),
        checkpoint=checkpoint,
        decisions=decisions,
    )
    return asyncio.run(runner.run()), events


def stored(checkpoint: dict) -> dict:
    """What comes back from storage: JSON in, JSON out."""
    return json.loads(json.dumps(checkpoint))


def types(events: list[dict]) -> list[str]:
    return [e["type"] for e in events]


GATE = compile_flow(
    flow(
        [
            node("t", "trigger_manual", "trigger"),
            node("gate", "hitl_approval", "approval", message="Publish “{{trigger.output}}”?"),
            node("yes", "output_display", "published"),
            node("no", "output_display", "discarded"),
        ],
        [edge("t", "gate"), edge("gate", "yes", "approved"), edge("gate", "no", "rejected")],
    )
)


def test_a_gate_pauses_the_run_with_a_checkpoint() -> None:
    outcome, events = run(GATE)
    assert outcome.status == "paused"
    assert outcome.statuses == {
        "t": "succeeded",
        "gate": "waiting",
        "yes": "pending",
        "no": "pending",
    }
    requested = next(e for e in events if e["type"] == "approval_requested")
    assert requested | {"at": None} == {
        "type": "approval_requested",
        "node_id": "gate",
        "message": "Publish “draft”?",
        "content": "draft",
        "allow_edit": True,
        "at": None,
    }
    assert "run_finished" not in types(events)  # the caller reports the pause
    checkpoint = stored(outcome.checkpoint)
    assert list(checkpoint["pending"]) == ["gate"] and checkpoint["input"] == "draft"


@pytest.mark.parametrize(
    ("decision", "taken", "skipped", "output"),
    [
        (Decision("gate", True), "yes", "no", "draft"),
        (Decision("gate", True, "polished draft", edited=True), "yes", "no", "polished draft"),
        (Decision("gate", False), "no", "yes", "draft"),
    ],
)
def test_resuming_continues_on_the_reviewers_branch(
    decision: Decision, taken: str, skipped: str, output: str
) -> None:
    paused, _ = run(GATE)
    outcome, events = run(GATE, checkpoint=stored(paused.checkpoint), decisions=[decision])
    assert outcome.status == "succeeded"
    assert outcome.outputs[taken] == output and outcome.outputs["gate"] == output
    assert outcome.statuses[skipped] == "skipped"
    assert types(events)[:2] == ["run_resumed", "approval_decided"]
    decided = events[1]
    assert (decided["approved"], decided["edited"]) == (decision.approved, decision.edited)
    gate_done = next(e for e in events if e["type"] == "node_finished" and e["node_id"] == "gate")
    assert gate_done["handles"] == ["approved" if decision.approved else "rejected"]
    assert events[-1]["type"] == "run_finished" and events[-1]["status"] == "succeeded"


def test_other_branches_keep_running_while_a_gate_waits() -> None:
    async def slow(ctx: NodeContext) -> NodeResult:
        await asyncio.sleep(0.05)
        return NodeResult("side work")

    plan = compile_flow(
        flow(
            [
                node("t", "trigger_manual"),
                node("gate", "hitl_approval"),
                node("side", "agent_node"),
                node("out", "output_display"),
            ],
            [edge("t", "gate"), edge("t", "side"), edge("side", "out")],
        )
    )
    outcome, _ = run(plan, extra={T.AGENT_NODE: slow})
    assert outcome.status == "paused"
    assert outcome.statuses["out"] == "succeeded" and outcome.outputs["out"] == "side work"


def test_parallel_gates_are_answered_one_at_a_time() -> None:
    plan = compile_flow(
        flow(
            [
                node("t", "trigger_manual"),
                node("legal", "hitl_approval"),
                node("brand", "hitl_approval"),
                node("ship", "output_display"),
            ],
            [
                edge("t", "legal"),
                edge("t", "brand"),
                edge("legal", "ship", "approved"),
                edge("brand", "ship", "approved"),
            ],
        )
    )
    first, _ = run(plan)
    assert sorted(first.checkpoint["pending"]) == ["brand", "legal"]
    second, _ = run(plan, checkpoint=stored(first.checkpoint), decisions=[Decision("legal", True)])
    assert second.status == "paused" and list(second.checkpoint["pending"]) == ["brand"]
    assert second.statuses["ship"] == "pending"  # still waits for its other input
    done, _ = run(plan, checkpoint=stored(second.checkpoint), decisions=[Decision("brand", True)])
    assert done.status == "succeeded"
    assert done.outputs["ship"] == {"legal": "draft", "brand": "draft"}


def test_a_gate_inside_a_loop_asks_on_every_pass() -> None:
    plan = compile_flow(
        flow(
            [
                node("t", "trigger_manual", input="v"),
                node("l", "logic_loop", max_iterations=2),
                node("a", "agent_node"),
                node("gate", "hitl_approval"),
                node("out", "output_display"),
            ],
            [
                edge("t", "l"),
                edge("l", "a", "loop"),
                edge("a", "gate"),
                edge("gate", "l", "approved"),
                edge("l", "out", "done"),
            ],
        )
    )
    outcome, _ = run(plan, input=None)
    contents = []
    while outcome.status == "paused":
        checkpoint = stored(outcome.checkpoint)
        contents.append(checkpoint["pending"]["gate"]["content"])
        outcome, _ = run(plan, checkpoint=checkpoint, decisions=[Decision("gate", True)])
    assert contents == ["v!", "v!!"]
    assert outcome.status == "succeeded" and outcome.outputs["out"] == "v!!"


def test_a_failure_elsewhere_fails_the_run_even_while_a_gate_waits() -> None:
    async def fail(ctx: NodeContext) -> NodeResult:
        await asyncio.sleep(0.01)
        raise NodeError("down")

    plan = compile_flow(
        flow(
            [node("t", "trigger_manual"), node("gate", "hitl_approval"), node("bad", "agent_node")],
            [edge("t", "gate"), edge("t", "bad")],
        )
    )
    outcome, events = run(plan, extra={T.AGENT_NODE: fail})
    assert outcome.status == "failed" and outcome.checkpoint is None
    assert events[-1]["type"] == "run_finished"


def test_only_waiting_gates_can_be_answered() -> None:
    paused, _ = run(GATE)
    with pytest.raises(ValueError, match="isn't waiting"):
        run(GATE, checkpoint=stored(paused.checkpoint), decisions=[Decision("yes", True)])


def test_old_checkpoints_are_refused() -> None:
    paused, _ = run(GATE)
    with pytest.raises(ValueError, match="unsupported checkpoint version"):
        run(GATE, checkpoint=stored(paused.checkpoint) | {"version": 0})


def test_the_gate_executor() -> None:
    plan = compile_flow(
        flow(
            [
                node("t", "trigger_manual"),
                node("g1", "hitl_approval", message="  "),
                node("g2", "hitl_approval", allow_edit=False),
            ],
            [edge("t", "g1"), edge("t", "g2")],
        )
    )
    outcome, _ = run(plan, input="x")
    pending = outcome.checkpoint["pending"]
    assert pending["g1"]["message"] == "Please review" and pending["g1"]["allow_edit"] is True
    assert pending["g2"]["allow_edit"] is False
