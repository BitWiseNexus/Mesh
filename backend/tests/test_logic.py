"""If / Else and Loop: their executors, and the runner's branch and loop scheduling."""

import asyncio
from typing import Any

import pytest

import app.engine.runner as runner_module
from app.engine.compiler import compile_flow
from app.engine.context import NodeContext
from app.engine.executor import NodeError, NodeResult, get_executor
from app.engine.runner import Runner
from app.nodes.executors.logic_if import evaluate
from app.schemas.node_types import NodeType
from tests.flows import edge, flow, node

T = NodeType


@pytest.mark.parametrize(
    ("left", "operator", "right", "expected"),
    [
        ("Yes", "equals", " yes ", True),  # case and surrounding spaces don't matter
        ("1.0", "equals", "1", True),  # numbers compare as numbers
        (3, "equals", "3", True),
        ("abc", "not_equals", "abd", True),
        ("The answer is YES.", "contains", "yes", True),
        ("no", "not_contains", "yes", True),
        (["Red", "green"], "contains", "red", True),  # lists: membership
        (["red"], "contains", "re", False),
        ({"a": 1}, "contains", '"a"', True),  # objects: their JSON text
        ("10", "greater_than", "9", True),  # not "10" < "9" as text
        ("2.5", "less_than", "3", True),
        ("1,000", "greater_than", "999", True),
        ("", "is_empty", "", True),
        ("  ", "is_empty", "", True),
        ([], "is_empty", "", True),
        ({}, "is_empty", "", True),
        (None, "is_empty", "", True),
        (0, "is_not_empty", "", True),
        (False, "equals", "false", True),
    ],
)
def test_evaluate(left: Any, operator: str, right: str, expected: bool) -> None:
    assert evaluate(left, operator, right) is expected


@pytest.mark.parametrize(("left", "right"), [("abc", "1"), ("1", "x"), (True, "1")])
def test_number_comparisons_need_numbers(left: Any, right: str) -> None:
    with pytest.raises(NodeError, match="compares numbers"):
        evaluate(left, "greater_than", right)


def run(f, *, executors: dict | None = None, input: str | None = None):
    events: list[dict] = []
    real = {
        t: get_executor(t) for t in (T.TRIGGER_MANUAL, T.LOGIC_IF, T.LOGIC_LOOP, T.OUTPUT_DISPLAY)
    }
    runner = Runner(
        compile_flow(f),
        run_id="r",
        input=input,
        sink=events.append,
        executors=real | (executors or {}),
    )
    return asyncio.run(runner.run()), events


def finished(events: list[dict], node_id: str) -> list[dict]:
    return [e for e in events if e["type"] == "node_finished" and e["node_id"] == node_id]


async def exclaim(ctx: NodeContext) -> NodeResult:
    """Stand-in for an agent: appends "!" to its input."""
    return NodeResult(f"{ctx.input}!")


AGENT = {T.AGENT_NODE: exclaim}


class TestIf:
    FLOW = flow(
        [
            node("t", "trigger_manual"),
            node("if", "logic_if", "check", operator="contains", value="yes"),
            node("yes", "agent_node"),
            node("no", "agent_node"),
            node("out", "output_display"),
        ],
        [
            edge("t", "if"),
            edge("if", "yes", "true"),
            edge("if", "no", "false"),
            edge("yes", "out"),
            edge("no", "out"),
        ],
    )

    @pytest.mark.parametrize(
        ("input", "taken", "skipped", "result"),
        [("Yes please", "yes", "no", "Yes please!"), ("nope", "no", "yes", "nope!")],
    )
    def test_routes_to_one_branch_and_rejoins(
        self, input: str, taken: str, skipped: str, result: str
    ) -> None:
        outcome, events = run(self.FLOW, executors=AGENT, input=input)
        assert outcome.status == "succeeded"
        assert outcome.statuses[taken] == "succeeded" and outcome.statuses[skipped] == "skipped"
        assert outcome.outputs["if"] == input  # passes its input through
        assert outcome.outputs["out"] == result  # one input delivered: passed as is
        [log] = [e for e in events if e["type"] == "log" and e["node_id"] == "if"]
        expected = "true" if taken == "yes" else "false"
        assert log["message"] == f"“{input}” contains “yes” → {expected}"

    def test_compares_referenced_values_and_reports_bad_numbers(self) -> None:
        f = flow(
            [
                node("t", "trigger_manual", "trigger"),
                node(
                    "if", "logic_if", field="{{trigger.output}}", operator="greater_than", value="5"
                ),
            ],
            [edge("t", "if")],
        )
        outcome, _ = run(f, input="12")
        assert finished_handles(outcome, "if") is None or outcome.status == "succeeded"
        outcome, _ = run(f, input="lots")
        assert outcome.status == "failed"
        assert "“is greater than” compares numbers, but “lots” isn't a number" in (
            outcome.error or ""
        )


def finished_handles(outcome: Any, node_id: str) -> Any:
    return outcome.statuses.get(node_id)


def loop_flow(*extra_nodes: dict, extra_edges: tuple = (), **loop_data: Any):
    """trigger → loop ⟲ a (appends "!") ; loop.done → out"""
    return flow(
        [
            node("t", "trigger_manual", "trigger", input="go"),
            node("l", "logic_loop", "loop", **loop_data),
            node("a", "agent_node", "work"),
            node("out", "output_display"),
            *extra_nodes,
        ],
        [
            edge("t", "l"),
            edge("l", "a", "loop"),
            edge("a", "l"),
            edge("l", "out", "done"),
            *extra_edges,
        ],
    )


class TestLoop:
    def test_runs_the_body_up_to_max_iterations(self) -> None:
        outcome, events = run(loop_flow(max_iterations=3), executors=AGENT)
        assert outcome.status == "succeeded"
        assert outcome.outputs["out"] == "go!!!"
        assert [e["handles"] for e in finished(events, "l")] == [["loop"]] * 3 + [["done"]]
        starts = [e for e in events if e["type"] == "node_started" and e["node_id"] == "a"]
        assert [e["iteration"] for e in starts] == [1, 2, 3]
        logs = [e["message"] for e in events if e["type"] == "log" and e["node_id"] == "l"]
        assert (
            logs[0] == "Iteration 1 of up to 3"
            and logs[-1] == "Done after 3 iterations (the maximum)"
        )

    def test_stops_when_the_result_contains_the_until_text(self) -> None:
        outcome, events = run(loop_flow(max_iterations=10, until="!!"), executors=AGENT)
        assert outcome.outputs["out"] == "go!!"
        assert len(finished(events, "a")) == 2

    def test_the_until_text_isnt_checked_on_the_way_in(self) -> None:
        f = loop_flow(max_iterations=2, until="go")  # the entering input already contains it
        outcome, events = run(f, executors=AGENT)
        assert len(finished(events, "a")) == 1 and outcome.outputs["out"] == "go!"

    def test_waits_for_side_branches_of_the_body(self) -> None:
        async def slow_log(ctx: NodeContext) -> NodeResult:
            await asyncio.sleep(0.05)
            return NodeResult(ctx.input)

        f = loop_flow(
            node("log", "output_display"),
            extra_edges=(edge("a", "log"),),
            max_iterations=3,
        )
        outcome, events = run(f, executors=AGENT | {T.OUTPUT_DISPLAY: slow_log})
        assert outcome.status == "succeeded" and outcome.outputs["out"] == "go!!!"
        order = [
            (e["type"], e["node_id"])
            for e in events
            if e["type"] in ("node_started", "node_finished") and e["node_id"] in ("l", "log")
        ]
        # Each pass's side branch finishes before the loop decides again.
        for i, item in enumerate(order):
            if item == ("node_started", "log"):
                assert order[i + 1] == ("node_finished", "log")
        assert len(finished(events, "log")) == 3

    def test_a_body_that_doesnt_come_back_ends_the_loop(self) -> None:
        # loop → a → if: "!!" not in it → back to the loop; otherwise → exit (inside the body)
        f = flow(
            [
                node("t", "trigger_manual", input="go"),
                node("l", "logic_loop", max_iterations=10),
                node("a", "agent_node"),
                node("if", "logic_if", operator="not_contains", value="!!"),
                node("exit", "output_display"),
                node("out", "output_display"),
            ],
            [
                edge("t", "l"),
                edge("l", "a", "loop"),
                edge("a", "if"),
                edge("if", "l", "true"),
                edge("if", "exit", "false"),
                edge("l", "out", "done"),
            ],
        )
        outcome, events = run(f, executors=AGENT)
        assert outcome.status == "succeeded"
        assert outcome.outputs["exit"] == "go!!"
        assert outcome.outputs["out"] == "go!"  # the loop's latest input
        messages = [e["message"] for e in events if e["type"] == "log" and e["node_id"] == "l"]
        assert "The loop body didn't come back, so the loop ends" in messages

    def test_a_loop_without_a_way_back_runs_its_body_once(self) -> None:
        f = flow(
            [
                node("t", "trigger_manual", input="go"),
                node("l", "logic_loop"),
                node("a", "agent_node"),
                node("body_out", "output_display"),
                node("out", "output_display"),
            ],
            [
                edge("t", "l"),
                edge("l", "a", "loop"),
                edge("a", "body_out"),
                edge("l", "out", "done"),
            ],
        )
        outcome, _ = run(f, executors=AGENT)
        assert outcome.outputs == {"t": "go", "l": "go", "a": "go!", "body_out": "go!", "out": "go"}

    def test_nested_loops_start_over_on_each_outer_pass(self) -> None:
        f = flow(
            [
                node("t", "trigger_manual", input="go"),
                node("outer", "logic_loop", max_iterations=2),
                node("inner", "logic_loop", max_iterations=2),
                node("a", "agent_node"),
                node("out", "output_display"),
            ],
            [
                edge("t", "outer"),
                edge("outer", "inner", "loop"),
                edge("inner", "a", "loop"),
                edge("a", "inner"),
                edge("inner", "outer", "done"),
                edge("outer", "out", "done"),
            ],
        )
        outcome, events = run(f, executors=AGENT)
        assert outcome.status == "succeeded"
        assert outcome.outputs["out"] == "go!!!!"
        assert len(finished(events, "a")) == 4
        a_iterations = [
            e["iteration"] for e in events if e["type"] == "node_started" and e["node_id"] == "a"
        ]
        assert a_iterations == [1, 2, 1, 2]  # the inner loop's pass

    def test_a_skipped_loop_skips_its_body_and_what_follows(self) -> None:
        f = flow(
            [
                node("t", "trigger_manual", input="x"),
                node("if", "logic_if", operator="equals", value="never"),
                node("l", "logic_loop"),
                node("a", "agent_node"),
                node("out", "output_display"),
            ],
            [
                edge("t", "if"),
                edge("if", "l", "true"),
                edge("l", "a", "loop"),
                edge("a", "l"),
                edge("l", "out", "done"),
            ],
        )
        outcome, _ = run(f, executors=AGENT)
        assert outcome.status == "succeeded"
        assert {k: outcome.statuses[k] for k in ("l", "a", "out")} == {
            "l": "skipped",
            "a": "skipped",
            "out": "skipped",
        }

    def test_runaway_loops_are_stopped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(runner_module, "MAX_NODE_RUNS", 7)
        outcome, _ = run(loop_flow(max_iterations=100), executors=AGENT)
        assert outcome.status == "failed"
        assert outcome.error == "The run stopped after 7 steps — check the flow's loops"

    def test_the_body_can_read_values_from_outside_the_loop_every_pass(self) -> None:
        # a also gets the trigger's output directly: that input stays delivered across passes.
        async def join(ctx: NodeContext) -> NodeResult:
            return NodeResult(f"{ctx.input['loop']}+")

        f = loop_flow(extra_edges=(edge("t", "a"),), max_iterations=3)
        outcome, events = run(f, executors={T.AGENT_NODE: join})
        assert outcome.status == "succeeded"
        assert outcome.outputs["out"] == "go+++"
        assert len(finished(events, "a")) == 3


def test_recorder_budget_isnt_used_up_by_repeated_nodes(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.repositories.runs as runs_repo
    from app.engine import events as ev

    monkeypatch.setattr(runs_repo, "RUN_OUTPUT_BUDGET", 100)
    writes: list[dict] = []

    class Repo:
        async def update(self, run_id: str, fields: dict) -> None:
            writes.append(fields)

    async def main() -> None:
        recorder = runs_repo.RunRecorder(Repo(), "r")  # type: ignore[arg-type]
        for i in range(20):  # 20 passes of a 40-character output
            recorder.record(ev.node_started("a", iteration=i + 1))
            recorder.record(ev.node_finished("a", "succeeded", output="x" * 38))
        await recorder.close()

    asyncio.run(main())
    merged: dict = {}
    for w in writes:
        merged |= w
    state = merged["node_states.a"]
    assert state["output_truncated"] is False and state["iteration"] == 20
