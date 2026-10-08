"""Node executors: the code that runs one node of a flow.

An executor is an async function registered for a node type:

    @executor(NodeType.OUTPUT_DISPLAY)
    async def show(ctx: NodeContext) -> NodeResult:
        return NodeResult(ctx.input)

It gets a `NodeContext` (the node, its resolved input, template rendering, token/log events) and
returns a `NodeResult`. Branch nodes choose which output handles deliver (`handles`); everything
else delivers on all of its outputs. Raise `NodeError` for failures users should read; any other
exception fails the node with a generic message (and is logged with its traceback).

Implementations live in `app/nodes/executors/` (one module per node type) and register on import.
Nodes attached to agents as tools run through `@tool` executors instead (app/engine/tools.py).
"""

import importlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from app.engine.compiler import ExecutionPlan
from app.engine.validation import FlowIssue
from app.nodes.catalog import get_spec
from app.schemas.node_types import NodeType

if TYPE_CHECKING:
    from app.engine.context import NodeContext


@dataclass(frozen=True)
class NodeResult:
    output: Any = None
    #: Output handles that deliver; None = all of the node's data outputs.
    handles: tuple[str, ...] | None = None


class NodeError(Exception):
    """A node failure with a message meant for the user (shown in the run panel)."""


Executor = Callable[["NodeContext"], Awaitable[NodeResult]]

_EXECUTORS: dict[NodeType, Executor] = {}
_loaded = False


def executor(node_type: NodeType) -> Callable[[Executor], Executor]:
    """Registers the decorated function as the executor for `node_type`."""

    def register(fn: Executor) -> Executor:
        if node_type in _EXECUTORS:
            raise RuntimeError(f"An executor for {node_type} is already registered")
        _EXECUTORS[node_type] = fn
        return fn

    return register


def load_executors() -> None:
    """Imports app/nodes/executors once, which registers every executor and tool."""
    global _loaded
    if not _loaded:
        _loaded = True
        importlib.import_module("app.nodes.executors")


def get_executor(node_type: NodeType) -> Executor | None:
    load_executors()
    return _EXECUTORS.get(node_type)


def runnable_types() -> frozenset[NodeType]:
    load_executors()
    return frozenset(_EXECUTORS)


def not_runnable_issues(plan: ExecutionPlan) -> list[FlowIssue]:
    """Nodes of `plan` this server can't execute yet: step types without an executor, and tool
    nodes whose type has no tool implementation. Empty when the run can start."""
    issues: list[FlowIssue] = []
    for node in plan.nodes.values():
        spec = get_spec(node.type)
        name = f"“{node.name}”"
        if node.role == "tool":
            from app.engine.tools import get_tool_kind  # tools builds on this module

            if get_tool_kind(node.type) is None:
                issues.append(
                    FlowIssue(
                        id=f"not-runnable:{node.id}",
                        severity="error",
                        node_id=node.id,
                        message=f"{name}: {spec.label} nodes can't be used as tools yet — "
                        "this arrives in a later update",
                    )
                )
        elif get_executor(node.type) is None:
            issues.append(
                FlowIssue(
                    id=f"not-runnable:{node.id}",
                    severity="error",
                    node_id=node.id,
                    message=f"{name}: {spec.label} nodes can't run yet — they arrive in a later "
                    "update",
                )
            )
    return issues
