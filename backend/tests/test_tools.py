"""Agent tools (app/engine/tools.py) and the agent's tool-calling loop."""

import asyncio
import json
from typing import Any

import pytest

from app.engine import events
from app.engine.compiler import compile_flow
from app.engine.context import NodeContext, RunContext
from app.engine.executor import NodeError, NodeResult
from app.engine.runner import Runner
from app.engine.tools import AgentTool, ToolKind, agent_tools, call_tool, input_parameters
from app.repositories.runs import RunRecorder
from tests.flows import edge, flow, node, tool_edge


def plan_with_tools(*tools: dict[str, Any], **agent_data: Any):
    agent = node("a", "agent_node", "lead", model="mock/tools", **agent_data)
    return compile_flow(
        flow(
            [node("t", "trigger_manual", "trigger", input="cats"), agent, *tools],
            [edge("t", "a"), *(tool_edge("a", t["id"]) for t in tools)],
        )
    )


def run_plan(plan, input: str | None = None) -> tuple[Any, list[dict]]:
    collected: list[dict] = []
    outcome = asyncio.run(Runner(plan, run_id="r", input=input, sink=collected.append).run())
    return outcome, collected


class TestParameters:
    def test_named_inputs_become_string_parameters(self) -> None:
        plan = plan_with_tools(
            node(
                "api",
                "tool_http",
                "orders",
                url="https://x.io/orders/{{input.order_id}}?q={{ input.query.0 }}",
                body='{"id": "{{input.order_id}}"}',
            )
        )
        schema, bare = input_parameters(plan.node("api"))
        assert bare is False
        assert schema == {
            "type": "object",
            "properties": {
                "order_id": {"type": "string", "description": "Value for {{input.order_id}}"},
                "query": {"type": "string", "description": "Value for {{input.query}}"},
            },
            "required": ["order_id", "query"],
            "additionalProperties": False,
        }

    def test_a_bare_input_is_one_input_parameter(self) -> None:
        plan = plan_with_tools(node("w", "agent_node", "writer", model="mock/echo"))
        schema, bare = input_parameters(plan.node("w"))  # Task defaults to {{input}}
        assert bare is True and list(schema["properties"]) == ["input"]

    def test_no_references_no_parameters(self) -> None:
        plan = plan_with_tools(node("api", "tool_http", url="https://x.io/status"))
        assert input_parameters(plan.node("api")) == (
            {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
            False,
        )


def test_agent_tools_describe_each_attached_node() -> None:
    plan = plan_with_tools(
        node("w", "agent_node", "writer", label="Writer", model="mock/echo"),
        node("w2", "agent_node", "editor", model="mock/echo", tool_description="  Fixes typos. "),
    )
    tools = agent_tools(plan, "a")
    assert [t.name for t in tools] == ["writer", "editor"]
    assert tools[0].description.startswith("Ask the “Writer” agent")
    assert tools[1].description == "Fixes typos."
    assert tools[0].schema()["function"]["name"] == "writer"
    assert tools[0].input_from({"input": "draft"}) == "draft"


def _ctx(events_out: list[dict]) -> NodeContext:
    plan = plan_with_tools(node("w", "agent_node", "writer", model="mock/echo"))
    return RunContext(plan, run_id="r", input=None, sink=events_out.append).node("a")


def _tool(run, parameters=None) -> dict[str, AgentTool]:
    plan = plan_with_tools(node("w", "agent_node", "writer", model="mock/echo"))
    schema = parameters or {"type": "object", "properties": {}}
    return {"x": AgentTool("x", plan.node("w"), "d", schema, False, ToolKind(run))}


class TestCallTool:
    def call(self, run, arguments: str = "{}", name: str = "x") -> tuple[str, list[dict]]:
        out: list[dict] = []
        text = asyncio.run(call_tool(_ctx(out), _tool(run), "c1", name, arguments))
        return text, out

    def test_success(self) -> None:
        async def run(ctx: NodeContext) -> NodeResult:
            return NodeResult({"echo": ctx.input})

        text, out = self.call(run, '{"q": "hi"}')
        assert json.loads(text) == {"echo": {"q": "hi"}}
        assert [e["type"] for e in out] == ["tool_call", "tool_result"]
        assert out[0] | {"at": None} == {
            "type": "tool_call",
            "node_id": "a",
            "tool_node_id": "w",
            "call_id": "c1",
            "name": "x",
            "arguments": {"q": "hi"},
            "at": None,
        }
        assert out[1]["status"] == "succeeded" and out[1]["output"] == {"echo": {"q": "hi"}}

    @pytest.mark.parametrize(
        ("run", "arguments", "name", "error"),
        [
            ("node_error", "{}", "x", "the API said no"),
            ("crash", "{}", "x", "Unexpected error: RuntimeError: boom"),
            ("ok", "{not json", "x", "Invalid arguments"),
            ("ok", "[1]", "x", "Invalid arguments (arguments must be a JSON object)"),
            ("ok", "{}", "nope", "There is no tool called “nope”"),
        ],
    )
    def test_failures_go_back_to_the_model(self, run, arguments, name, error) -> None:
        async def node_error(ctx: NodeContext) -> NodeResult:
            raise NodeError("the API said no")

        async def crash(ctx: NodeContext) -> NodeResult:
            raise RuntimeError("boom")

        async def ok(ctx: NodeContext) -> NodeResult:
            return NodeResult("fine")

        fn = {"node_error": node_error, "crash": crash, "ok": ok}[run]
        text, out = self.call(fn, arguments, name)
        assert json.loads(text)["error"].startswith(error)
        assert out[-1]["type"] == "tool_result" and out[-1]["status"] == "failed"
        assert out[-1]["error"].startswith(error) and "output" not in out[-1]

    def test_timeout(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from app.core.config import Settings

        monkeypatch.setattr(
            "app.engine.tools.get_settings", lambda: Settings(tool_timeout_seconds=1)
        )

        async def slow(ctx: NodeContext) -> NodeResult:
            await asyncio.sleep(5)
            return NodeResult()

        text, _ = self.call(slow)
        assert json.loads(text) == {"error": "The tool didn't finish within 1 s"}

    def test_long_results_are_cut(self) -> None:
        async def big(ctx: NodeContext) -> NodeResult:
            return NodeResult("x" * 250_000)

        text, out = self.call(big)
        assert len(text) < 200_100 and text.endswith("[… cut after 200000 characters]")
        assert out[-1]["output"] == "x" * 250_000  # the event keeps the full output


def test_agent_calls_an_agent_tool_and_answers_with_the_results() -> None:
    plan = plan_with_tools(
        node("w", "agent_node", "writer", model="mock/echo", prompt="Write about {{input}}")
    )
    outcome, out = run_plan(plan)
    assert outcome.status == "succeeded"
    assert outcome.outputs["a"] == "Tool results: writer: Write about cats"
    kinds = [(e["type"], e.get("node_id"), e.get("tool_node_id")) for e in out]
    assert ("tool_call", "a", "w") in kinds and ("tool_result", "a", "w") in kinds
    # The worker streamed its own reply under its own node id.
    assert "".join(e["text"] for e in out if e["type"] == "token" and e["node_id"] == "w") == (
        "Write about cats"
    )
    # Tools aren't steps: no node_started / node_finished for the worker.
    assert not any(e.get("node_id") == "w" and e["type"].startswith("node_") for e in out)


def test_tool_rounds_are_capped_then_the_agent_must_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.llm import ChatResult, ToolCall

    rounds: list[str | None] = []

    async def always_calls(model, messages, *, tools, tool_choice, on_text, **kw):
        if tools is None:  # the worker agent (no tools of its own)
            return ChatResult("worked")
        rounds.append(tool_choice)
        if tool_choice == "none":
            return ChatResult("final answer")
        return ChatResult(tool_calls=[ToolCall(f"c{len(rounds)}", "writer", '{"input": "x"}')])

    monkeypatch.setattr("app.nodes.executors.agent.complete", always_calls)
    plan = plan_with_tools(node("w", "agent_node", "writer", model="mock/echo"), max_tool_steps=2)
    outcome, out = run_plan(plan)
    assert rounds == [None, None, "none"]
    assert outcome.outputs["a"] == "final answer"
    assert sum(e["type"] == "tool_call" for e in out) == 2


def test_recorder_keeps_each_tools_latest_call() -> None:
    writes: list[dict] = []

    class Repo:
        async def update(self, run_id: str, fields: dict) -> None:
            writes.append(fields)

    async def main() -> None:
        recorder = RunRecorder(Repo(), "r")  # type: ignore[arg-type]
        for e in [
            events.tool_call("a", "w", "c1", "writer", {"input": "x"}),
            events.tool_result("a", "w", "c1", error="no"),
            events.tool_call("a", "w", "c2", "writer", {"input": "y"}),
            events.tool_result("a", "w", "c2", output="done"),
            events.tool_call("a", "", "c3", "ghost", {}),  # unknown tool: nothing to record
        ]:
            recorder.record(e)
        await recorder.close()

    asyncio.run(main())
    merged: dict = {}
    for w in writes:
        merged |= w
    state = merged["node_states.w"]
    assert state["status"] == "succeeded" and state["calls"] == 2
    assert json.loads(state["output_json"]) == "done" and "error" not in state
    assert "node_states." not in merged
