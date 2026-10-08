"""Run context and template resolution (app/engine/context.py)."""

from typing import Any

import pytest

from app.engine.compiler import PlanEdge, compile_flow
from app.engine.context import MISSING, RunContext, lookup, to_text
from tests.flows import edge, flow, node

# trigger → a ─┐
#        └→ b ─┴→ join      (refs: trigger, writer, b)
FLOW = flow(
    [
        node("t", "trigger_manual", "trigger"),
        node("a", "agent_node", "writer"),
        node("b", "agent_node"),
        node("join", "output_display"),
    ],
    [edge("t", "a"), edge("t", "b"), edge("a", "join"), edge("b", "join")],
)


def context(**outputs: Any) -> tuple[RunContext, list[dict]]:
    events: list[dict] = []
    ctx = RunContext(compile_flow(FLOW), run_id="r", input="run input", sink=events.append)
    ctx.outputs.update(outputs)
    return ctx, events


def deliver(ctx: RunContext, *sources: str, target: str = "join") -> None:
    for s in sources:
        ctx.delivered.setdefault(target, []).append(
            PlanEdge(f"{s}-{target}", s, "out", target, "in")
        )


def test_input_of_the_trigger_is_the_run_input() -> None:
    ctx, _ = context()
    assert ctx.input_of("t") == "run input"


def test_one_delivered_input_is_passed_as_is() -> None:
    ctx, _ = context(a={"x": 1})
    deliver(ctx, "a")
    assert ctx.input_of("join") == {"x": 1}


def test_several_inputs_are_keyed_by_ref_or_id() -> None:
    ctx, _ = context(a="from a", b="from b")
    deliver(ctx, "a", "b")
    assert ctx.input_of("join") == {"writer": "from a", "b": "from b"}


@pytest.mark.parametrize(
    ("value", "path", "expected"),
    [
        ({"a": {"b": [10, 20]}}, ["a", "b", "1"], 20),
        ([1, 2], ["5"], MISSING),
        ({"a": 1}, ["b"], MISSING),
        ("plain text", ["x"], MISSING),
        ('{"summary": "short", "items": [{"n": 1}]}', ["items", "0", "n"], 1),  # JSON text
        ("{not json", ["x"], MISSING),
        ({"0": "key"}, ["0"], "key"),
        ("text", [], "text"),
    ],
)
def test_lookup(value: Any, path: list[str], expected: Any) -> None:
    assert lookup(value, path) == expected


@pytest.mark.parametrize(
    ("value", "text"),
    [
        (None, ""),
        ("s", "s"),
        (True, "true"),
        (3, "3"),
        (2.5, "2.5"),
        ({"a": [1]}, '{\n  "a": [\n    1\n  ]\n}'),
        (["é"], '[\n  "é"\n]'),
    ],
)
def test_to_text(value: Any, text: str) -> None:
    assert to_text(value) == text


def test_render_replaces_references() -> None:
    ctx, events = context(t="start", a='{"summary": "short"}', b=["x", "y"])
    deliver(ctx, "a", "b")
    node_ctx = ctx.node("join")
    assert node_ctx.render("A={{writer.output.summary}} B={{ b.output.1 }} T={{t.output}}") == (
        "A=short B=y T=start"
    )
    assert node_ctx.render("{{input.writer}}|{{input.b.0}}") == '{"summary": "short"}|x'
    assert events == []


def test_missing_values_render_empty_with_a_warning() -> None:
    ctx, events = context(t="start")  # a and b never ran (e.g. skipped)
    deliver(ctx, "a")
    node_ctx = ctx.node("join")
    assert node_ctx.render("[{{writer.output}}][{{t.output.nope}}][{{input.x}}]") == "[][][]"
    assert [(e["level"], e["message"], e["node_id"]) for e in events] == [
        ("warning", "{{writer.output}} has no value: that node didn't run", "join"),
        ("warning", "{{t.output.nope}} has no value", "join"),
        ("warning", "{{input.x}} has no value", "join"),
    ]


def test_value_keeps_single_references_raw() -> None:
    ctx, _ = context(a={"items": [1, 2]})
    deliver(ctx, "a")
    node_ctx = ctx.node("join")
    assert node_ctx.value(" {{input}} ") == {"items": [1, 2]}
    assert node_ctx.value("{{writer.output.items}}") == [1, 2]
    assert node_ctx.value("n={{writer.output.items.0}}") == "n=1"
    assert node_ctx.value("{{b.output}}") is None  # missing


def test_field_renders_config_and_tolerates_non_text() -> None:
    ctx, _ = context()
    node_ctx = ctx.node("a")  # data has defaults: prompt "{{input}}", temperature 0.7
    deliver(ctx, "t", target="a")
    ctx.outputs["t"] = "hello"
    assert node_ctx.field("prompt") == "hello"
    assert node_ctx.field("temperature") == "0.7"
    assert node_ctx.field("missing") == ""


def test_token_and_log_events() -> None:
    ctx, events = context()
    node_ctx = ctx.node("a")
    node_ctx.token("")  # ignored
    node_ctx.token("Hi")
    node_ctx.log("Calling the model")
    assert [(e["type"], e.get("text") or e.get("message")) for e in events] == [
        ("token", "Hi"),
        ("log", "Calling the model"),
    ]
