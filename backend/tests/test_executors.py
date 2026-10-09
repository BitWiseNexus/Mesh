"""Executor registry (app/engine/executor.py) and the node executors (app/nodes/executors/)."""

import asyncio

import pytest

from app.engine.compiler import PlanEdge, compile_flow
from app.engine.context import RunContext
from app.engine.executor import (
    NodeError,
    NodeResult,
    executor,
    get_executor,
    not_runnable_issues,
    runnable_types,
)
from app.llm import ChatResult
from app.schemas.node_types import NodeType
from tests.flows import edge, flow, node, tool_edge


def test_registered_executors() -> None:
    assert runnable_types() == {
        NodeType.TRIGGER_MANUAL,
        NodeType.LOGIC_IF,
        NodeType.LOGIC_LOOP,
        NodeType.AGENT_NODE,
        NodeType.OUTPUT_DISPLAY,
    }


def test_registering_a_type_twice_fails() -> None:
    with pytest.raises(RuntimeError, match="already registered"):

        @executor(NodeType.OUTPUT_DISPLAY)
        async def again(ctx) -> NodeResult:  # pragma: no cover
            return NodeResult()


def test_not_runnable_nodes_and_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    # Every available tool type has an implementation; pretend Web Search doesn't.
    monkeypatch.setattr("app.engine.tools.get_tool_kind", lambda node_type: None)
    plan = compile_flow(
        flow(
            [
                node("t", "trigger_manual"),
                node("ok", "hitl_approval"),
                node("a", "agent_node"),
                node("s", "tool_web_search"),
            ],
            [edge("t", "ok"), edge("ok", "a", "approved"), tool_edge("a", "s")],
        )
    )
    assert [(i.id, i.message) for i in not_runnable_issues(plan)] == [
        (
            "not-runnable:ok",
            "“Approval Gate”: Approval Gate nodes can't run yet — they arrive in a later update",
        ),
        (
            "not-runnable:s",
            "“Web Search”: Web Search nodes can't be used as tools yet — this arrives in a later "
            "update",
        ),
    ]
    starter = flow([node("t", "trigger_manual"), node("o", "output_display")], [edge("t", "o")])
    assert not_runnable_issues(compile_flow(starter)) == []


def _run_agent(input: str, **data) -> tuple[NodeResult, list[dict]]:
    events: list[dict] = []
    plan = compile_flow(
        flow(
            [node("t", "trigger_manual", "trigger"), node("a", "agent_node", **data)],
            [edge("t", "a")],
        )
    )
    ctx = RunContext(plan, run_id="r", input=input, sink=events.append)
    ctx.outputs["t"] = input
    ctx.delivered["a"] = [PlanEdge("e", "t", "out", "a", "in")]
    result = asyncio.run(get_executor(NodeType.AGENT_NODE)(ctx.node("a")))
    return result, events


def test_agent_streams_the_reply(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list = []

    async def fake_complete(model, messages, *, temperature=None, on_text, **kwargs):
        sent.append((model, list(messages), temperature))
        assert kwargs == {"tools": None, "tool_choice": None, "api_key": None}  # no tools, no key
        for chunk in ("Hel", "lo"):
            on_text(chunk)
        return ChatResult("Hello")

    monkeypatch.setattr("app.nodes.executors.agent.complete", fake_complete)
    result, events = _run_agent(
        "the input",
        model="gpt-4o",
        system_prompt="Be brief about {{trigger.output}}",
        prompt="Task: {{input}}",
        temperature=0.2,
    )
    assert result == NodeResult("Hello")
    assert sent == [
        (
            "gpt-4o",
            [
                {"role": "system", "content": "Be brief about the input"},
                {"role": "user", "content": "Task: the input"},
            ],
            0.2,
        )
    ]
    assert [e["text"] for e in events if e["type"] == "token"] == ["Hel", "lo"]


def test_agent_without_system_prompt_sends_only_the_task() -> None:
    result, _ = _run_agent("ping", model="mock/echo")
    assert result.output == "ping"


@pytest.mark.parametrize(
    ("data", "message"),
    [
        ({"model": "mock/echo", "prompt": "  "}, "The Task is empty"),
        ({"model": "mock/nope"}, "Unknown mock model"),
    ],
)
def test_agent_errors(data: dict, message: str) -> None:
    with pytest.raises(NodeError, match=message):
        _run_agent("x", **data)
