"""Agent tools: nodes attached to an agent's Tools handle, offered to its LLM as functions.

Each attached node becomes one function, named after the node's ref. Calling it runs the node's
tool executor with `{{input}}` = the arguments the agent passed:

- Built-in tools declare fixed parameters (Web Search: `query`, Web Scraper: `url`).
- Other tools (API Caller, an agent used as a tool) get their parameters from their templated
  fields: every `{{input.<name>}}` becomes a string parameter `<name>`. A bare `{{input}}` with no
  named ones means one parameter, `input`, and `{{input}}` is then that string.

A failing call doesn't fail the run: the error goes back to the agent as the tool's result (and
is shown in the run panel), so the model can retry or answer anyway.

Tool executors are registered like step executors (app/engine/executor.py), with `@tool`.
"""

import asyncio
import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.core.config import get_settings
from app.engine import events
from app.engine.compiler import ExecutionPlan, PlannedNode
from app.engine.context import NodeContext
from app.engine.executor import Executor, NodeError, NodeResult, load_executors
from app.engine.references import InputPart, parse_template
from app.nodes.catalog import get_spec
from app.schemas.node_types import NodeType

logger = logging.getLogger(__name__)

#: Safety cap on a tool result sent back to the model. Tools bound their own output below this
#: (Web Scraper: its "Max characters"; API Caller: 50k).
RESULT_MAX_CHARS = 200_000

Schema = dict[str, Any]


@dataclass(frozen=True)
class ToolKind:
    run: Executor
    #: JSON schema of the arguments; None → derived from {{input.<name>}} references.
    parameters: Schema | None = None
    #: Default description for the model (when the node has no "Description for the agent").
    description: Callable[[PlannedNode], str] | None = None


_TOOL_KINDS: dict[NodeType, ToolKind] = {}


def tool(
    node_type: NodeType,
    *,
    parameters: Schema | None = None,
    description: Callable[[PlannedNode], str] | None = None,
) -> Callable[[Executor], Executor]:
    """Registers the decorated executor as `node_type`'s implementation when used as a tool."""

    def register(fn: Executor) -> Executor:
        if node_type in _TOOL_KINDS:
            raise RuntimeError(f"A tool for {node_type} is already registered")
        _TOOL_KINDS[node_type] = ToolKind(fn, parameters, description)
        return fn

    return register


def get_tool_kind(node_type: NodeType) -> ToolKind | None:
    load_executors()
    return _TOOL_KINDS.get(node_type)


def input_parameters(node: PlannedNode) -> tuple[Schema, bool]:
    """Parameters declared by `{{input…}}` references in the node's templated fields, and whether
    `{{input}}` is the single `input` argument (True) rather than the arguments object."""
    names: dict[str, None] = {}
    bare = False
    for field in get_spec(node.type).fields:
        value = node.data.get(field.key)
        if not field.templated or not isinstance(value, str):
            continue
        for part in parse_template(value):
            if isinstance(part, InputPart):
                if part.path:
                    names.setdefault(part.path[0])
                else:
                    bare = True
    if not names and bare:
        return object_schema({"input": "What to pass to this tool"}), True
    return object_schema({name: f"Value for {{{{input.{name}}}}}" for name in names}), False


def object_schema(properties: dict[str, str]) -> Schema:
    """A JSON schema for an object of required string properties (name → description)."""
    return {
        "type": "object",
        "properties": {k: {"type": "string", "description": v} for k, v in properties.items()},
        "required": list(properties),
        "additionalProperties": False,
    }


def _function_name(node: PlannedNode) -> str:
    # Refs already fit ([a-z][a-z0-9_]*); ids of older flows might not.
    return re.sub(r"[^A-Za-z0-9_-]", "_", node.ref)[:64]


@dataclass(frozen=True)
class AgentTool:
    name: str
    node: PlannedNode
    description: str
    parameters: Schema
    #: `{{input}}` is the `input` argument itself rather than the arguments object.
    bare_input: bool
    kind: ToolKind

    def schema(self) -> dict[str, Any]:
        """The function definition sent to the model (OpenAI format; LiteLLM converts it)."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    def input_from(self, arguments: dict[str, Any]) -> Any:
        return arguments.get("input", "") if self.bare_input else arguments


def agent_tools(plan: ExecutionPlan, agent_id: str) -> list[AgentTool]:
    """The tools of `agent_id`, in attachment order. Every one has a registered kind (runs are
    refused otherwise, see not_runnable_issues)."""
    result: list[AgentTool] = []
    for tool_id in plan.node(agent_id).tools:
        node = plan.node(tool_id)
        kind = get_tool_kind(node.type)
        if kind is None:
            raise RuntimeError(f"{node.type} can't be used as a tool")
        if kind.parameters is not None:
            parameters, bare = kind.parameters, False
        else:
            parameters, bare = input_parameters(node)
        custom = node.data.get("tool_description")
        if isinstance(custom, str) and custom.strip():
            description = custom.strip()
        elif kind.description is not None:
            description = kind.description(node)
        else:
            description = f"{node.name}: {get_spec(node.type).description}"
        result.append(AgentTool(_function_name(node), node, description, parameters, bare, kind))
    return result


def _encode(value: Any) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    if len(text) > RESULT_MAX_CHARS:
        text = text[:RESULT_MAX_CHARS] + f"\n[… cut after {RESULT_MAX_CHARS} characters]"
    return text


async def call_tool(
    ctx: NodeContext,
    tools: dict[str, AgentTool],
    call_id: str,
    name: str,
    raw_arguments: str,
) -> str:
    """Runs one tool call of the agent in `ctx` and returns the result text for the model."""
    found = tools.get(name)
    tool_node_id = found.node.id if found else ""
    try:
        arguments = json.loads(raw_arguments) if raw_arguments.strip() else {}
        if not isinstance(arguments, dict):
            raise ValueError("arguments must be a JSON object")
    except ValueError as exc:
        arguments = None
        problem = f"Invalid arguments ({exc})"
    else:
        problem = None if found else f"There is no tool called “{name}”"

    ctx.emit(
        events.tool_call(
            ctx.node.id,
            tool_node_id,
            call_id,
            name,
            raw_arguments if arguments is None else arguments,
        )
    )
    if problem is None and found is not None and arguments is not None:
        tool_ctx = ctx.run.node(found.node.id, input=found.input_from(arguments))
        timeout = get_settings().tool_timeout_seconds
        try:
            async with asyncio.timeout(timeout):
                result = await found.kind.run(tool_ctx)
            if not isinstance(result, NodeResult):
                raise TypeError(f"tool returned {type(result).__name__}, not NodeResult")
        except NodeError as exc:
            problem = str(exc)
        except TimeoutError:
            problem = f"The tool didn't finish within {timeout:g} s"
        except Exception as exc:
            logger.exception("Tool %s (%s) crashed", found.node.id, found.node.type)
            problem = f"Unexpected error: {type(exc).__name__}: {exc}"
        else:
            ctx.emit(events.tool_result(ctx.node.id, tool_node_id, call_id, output=result.output))
            return _encode(result.output)

    assert problem is not None
    ctx.emit(events.tool_result(ctx.node.id, tool_node_id, call_id, error=problem))
    return json.dumps({"error": problem}, ensure_ascii=False)
