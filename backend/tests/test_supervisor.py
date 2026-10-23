"""The Supervisor Agent (app/nodes/executors/agent_supervisor.py): its coordinator instructions,
delegation rounds, and real runs with the mock models."""

import asyncio
import json
from typing import Any

import pytest

from app.engine.compiler import compile_flow
from app.engine.runner import Runner
from app.engine.tools import agent_tools
from app.llm import ChatResult, ToolCall
from app.nodes.executors.agent import AGENT_TASK
from app.nodes.executors.agent_supervisor import supervisor_instructions
from tests.flows import edge, flow, node, tool_edge


def team_flow(lead: dict[str, Any] | None = None, **workers: dict[str, Any]) -> Any:
    """Trigger → Supervisor “lead” (→ Output), with `workers` attached to its Tools handle."""
    nodes = [
        node("t", "trigger_manual", "trigger"),
        node("lead", "agent_supervisor", "lead", **{"model": "mock/tools", **(lead or {})}),
        node("out", "output_display", "result"),
        *(node(ref, data.pop("type", "agent_node"), ref, **data) for ref, data in workers.items()),
    ]
    edges = [edge("t", "lead"), edge("lead", "out"), *(tool_edge("lead", ref) for ref in workers)]
    return compile_flow(flow(nodes, edges))


def run(plan: Any, input: str = "Plan a launch") -> tuple[str, list[dict]]:
    events: list[dict] = []
    outcome = asyncio.run(Runner(plan, run_id="r", input=input, sink=events.append).run())
    return outcome.status, events


def output_of(events: list[dict], node_id: str) -> Any:
    return next(
        e["output"] for e in events if e["type"] == "node_finished" and e["node_id"] == node_id
    )


# ── Instructions ──────────────────────────────────────────────────────────


def test_instructions_name_the_team_and_the_tools() -> None:
    plan = team_flow(
        writer={"model": "mock/echo", "tool_description": "Writes copy"},
        researcher={"model": "mock/echo", "label": "Researcher"},
        search={"type": "tool_web_search"},
    )
    text = supervisor_instructions(agent_tools(plan, "lead"), "Answer in French.")
    assert text.startswith("You are a supervisor. You lead a team of worker agents")
    assert "- writer: Writes copy" in text
    assert "- researcher: Ask the “Researcher” agent to do something" in text
    assert "Workers only see what you send them" in text
    assert "You can also use these tools directly:\n- search: Search the web" in text
    assert text.endswith("Further instructions:\nAnswer in French.")


def test_without_workers_it_works_alone() -> None:
    assert "You have no workers attached: do the task yourself." in supervisor_instructions([], "")


def test_workers_are_asked_for_the_whole_task() -> None:
    plan = team_flow(writer={"model": "mock/echo"})
    [writer] = agent_tools(plan, "lead")
    assert writer.parameters["properties"]["input"]["description"] == AGENT_TASK


# ── Delegation (scripted model) ──────────────────────────────────────────


def test_delegates_in_rounds_then_answers(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, list[dict], Any]] = []

    async def fake_complete(model, messages, *, tools, tool_choice, on_text, **kwargs):
        calls.append((model, list(messages), tool_choice))
        if model == "worker":
            return ChatResult(f"done: {messages[-1]['content']}")
        results = [m["content"] for m in messages if m["role"] == "tool"]
        if not results:  # first round: hand out both sub-tasks at once
            return ChatResult(
                "",
                [
                    ToolCall("c1", "writer", json.dumps({"input": "Write the announcement"})),
                    ToolCall("c2", "researcher", json.dumps({"input": "Find launch dates"})),
                ],
            )
        on_text("Combined")
        return ChatResult("Combined: " + " | ".join(results))

    monkeypatch.setattr("app.nodes.executors.agent.complete", fake_complete)
    plan = team_flow(
        {"model": "boss", "system_prompt": "Be brief.", "max_rounds": 3},
        writer={"model": "worker"},
        researcher={"model": "worker"},
    )
    status, events = run(plan)
    assert status == "succeeded"
    assert output_of(events, "out") == (
        "Combined: done: Write the announcement | done: Find launch dates"
    )
    boss_calls = [c for c in calls if c[0] == "boss"]
    assert len(boss_calls) == 2
    system = boss_calls[0][1][0]
    assert system["role"] == "system" and system["content"].endswith("Be brief.")
    assert boss_calls[0][1][1] == {"role": "user", "content": "Plan a launch"}
    tool_calls = [e for e in events if e["type"] == "tool_call"]
    assert [(e["node_id"], e["tool_node_id"]) for e in tool_calls] == [
        ("lead", "writer"),
        ("lead", "researcher"),
    ]


def test_max_rounds_forces_an_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    choices: list[Any] = []

    async def fake_complete(model, messages, *, tools, tool_choice, on_text, **kwargs):
        if model == "worker":
            return ChatResult("ok")
        choices.append(tool_choice)
        if tool_choice == "none":
            return ChatResult("Out of rounds, here's what I have")
        return ChatResult("", [ToolCall(f"c{len(choices)}", "writer", '{"input": "again"}')])

    monkeypatch.setattr("app.nodes.executors.agent.complete", fake_complete)
    plan = team_flow({"model": "boss", "max_rounds": 2}, writer={"model": "worker"})
    status, events = run(plan)
    assert status == "succeeded"
    assert choices == [None, None, "none"]  # two rounds of delegation, then it must answer
    assert output_of(events, "out") == "Out of rounds, here's what I have"


# ── Real runs with the mock models ───────────────────────────────────────


def test_a_team_runs_with_the_mock_models() -> None:
    plan = team_flow(
        writer={"model": "mock/echo", "prompt": "Writer: {{input}}"},
        researcher={"model": "mock/echo", "prompt": "Researcher: {{input}}"},
    )
    status, events = run(plan)
    assert status == "succeeded"
    answer = output_of(events, "out")
    assert "Writer: Plan a launch" in answer and "Researcher: Plan a launch" in answer
    assert {e["tool_node_id"] for e in events if e["type"] == "tool_result"} == {
        "writer",
        "researcher",
    }


def test_a_supervisor_can_be_another_supervisors_worker() -> None:
    nodes = [
        node("t", "trigger_manual", "trigger"),
        node("ceo", "agent_supervisor", "ceo", model="mock/tools"),
        node("manager", "agent_supervisor", "manager", model="mock/tools"),
        node("dev", "agent_node", "dev", model="mock/echo", prompt="Dev: {{input}}"),
        node("out", "output_display", "result"),
    ]
    edges = [
        edge("t", "ceo"),
        edge("ceo", "out"),
        tool_edge("ceo", "manager"),
        tool_edge("manager", "dev"),
    ]
    status, events = run(compile_flow(flow(nodes, edges)), "Ship it")
    assert status == "succeeded"
    assert "Dev: Ship it" in output_of(events, "out")
    calls = [(e["node_id"], e["tool_node_id"]) for e in events if e["type"] == "tool_call"]
    assert calls == [("ceo", "manager"), ("manager", "dev")]
