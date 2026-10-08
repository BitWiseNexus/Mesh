import pytest

from app.engine.compiler import (
    FlowNotRunnableError,
    InvalidTriggerError,
    PlanEdge,
    compile_flow,
)
from tests.flows import edge, flow, node, tool_edge

STARTER = flow(
    [node("t", "trigger_manual", "trigger"), node("out", "output_display", "result")],
    [edge("t", "out")],
)


def test_compiles_the_starter_flow() -> None:
    plan = compile_flow(STARTER)
    assert plan.flow_id == "f1" and plan.trigger_id == "t"
    assert [n.id for n in plan.steps] == ["t", "out"]
    trigger, out = plan.node("t"), plan.node("out")
    link = PlanEdge("t-out-out", "t", "out", "out", "in")
    assert trigger.inputs == () and trigger.outputs == {"out": (link,)}
    assert out.inputs == (link,) and out.outputs == {}
    assert trigger.data == {"input": ""}  # defaults filled in
    assert plan.warnings == ()


def test_refuses_flows_with_errors_and_lists_them() -> None:
    broken = flow([node("out", "output_display")], [])
    with pytest.raises(FlowNotRunnableError) as raised:
        compile_flow(broken)
    err = raised.value
    assert (err.status_code, err.code) == (422, "flow_invalid")
    assert err.message == "The flow has 1 error to fix before it can run."
    assert err.extra["issues"] == [
        {
            "id": "no-trigger",
            "severity": "error",
            "message": "Add a trigger so the flow has a starting point",
            "fix": "add_trigger",
        }
    ]


def test_warnings_dont_block_a_run() -> None:
    plan = compile_flow(
        flow(
            [node("t", "trigger_manual"), node("orphan", "output_display")],
            [],
        )
    )
    assert [w.id for w in plan.warnings] == ["unreachable:orphan"]
    assert list(plan.nodes) == ["t"]  # unreachable nodes aren't part of the run


class TestTriggers:
    two = flow(
        [
            node("t1", "trigger_manual"),
            node("t2", "trigger_manual"),
            node("a", "agent_node"),
            node("b", "agent_node"),
            node("join", "output_display"),
        ],
        [edge("t1", "a"), edge("t2", "b"), edge("a", "join"), edge("b", "join")],
    )

    def test_several_triggers_need_a_choice(self) -> None:
        with pytest.raises(InvalidTriggerError) as raised:
            compile_flow(self.two)
        assert raised.value.extra == {"triggers": ["t1", "t2"]}

    def test_rejects_unknown_or_non_trigger_ids(self) -> None:
        for bad in ("nope", "a"):
            with pytest.raises(InvalidTriggerError):
                compile_flow(self.two, bad)

    def test_only_the_chosen_triggers_branch_runs(self) -> None:
        plan = compile_flow(self.two, "t2")
        assert [n.id for n in plan.steps] == ["t2", "b", "join"]
        # The edge from the other trigger's branch can never deliver, so the join doesn't wait.
        assert [e.source for e in plan.node("join").inputs] == ["b"]


def test_branch_outputs_list_every_handle() -> None:
    plan = compile_flow(
        flow(
            [
                node("t", "trigger_manual"),
                node("if", "logic_if", value="x"),
                node("yes", "output_display"),
            ],
            [edge("t", "if"), edge("if", "yes", "true")],
        )
    )
    outputs = plan.node("if").outputs
    assert list(outputs) == ["true", "false"]
    assert [e.target for e in outputs["true"]] == ["yes"] and outputs["false"] == ()


def test_null_handles_resolve_to_the_first_handle() -> None:
    plan = compile_flow(
        flow(
            [node("t", "trigger_manual"), node("out", "output_display")],
            [edge("t", "out", None, targetHandle=None)],
        )
    )
    [link] = plan.node("out").inputs
    assert (link.source_handle, link.target_handle) == ("out", "in")


def test_tools_are_attached_not_scheduled() -> None:
    plan = compile_flow(
        flow(
            [
                node("t", "trigger_manual"),
                node("lead", "agent_node"),
                node("search", "tool_web_search"),
                node("worker", "agent_node"),
                node("api", "tool_http", url="https://x.io"),
                node("idle", "agent_node"),
                node("idle_tool", "tool_web_search"),
            ],
            [
                edge("t", "lead"),
                tool_edge("lead", "search"),
                tool_edge("lead", "worker"),  # an agent used as a tool, with its own tool
                tool_edge("worker", "api"),
                tool_edge("idle", "idle_tool"),  # idle never runs, so neither does its tool
            ],
        )
    )
    assert [n.id for n in plan.steps] == ["t", "lead"]
    assert plan.node("lead").tools == ("search", "worker")
    worker = plan.node("worker")
    assert (worker.role, worker.tools, worker.inputs, worker.outputs) == ("tool", ("api",), (), {})
    assert plan.node("api").role == "tool"
    assert "idle" not in plan.nodes and "idle_tool" not in plan.nodes


def test_names_resolve_refs_first_then_ids() -> None:
    plan = compile_flow(
        flow(
            [node("t", "trigger_manual", "trigger"), node("node_legacy", "output_display")],
            [edge("t", "node_legacy")],
        )
    )
    assert plan.names == {"t": "t", "trigger": "t", "node_legacy": "node_legacy"}
    assert plan.node("node_legacy").ref == "node_legacy"  # no ref: templates use the id
    assert plan.node("t").ref == "trigger"
