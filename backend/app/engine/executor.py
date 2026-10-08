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
Executors for nodes used as agent *tools* arrive with tool calling (Phase 4).
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


def _load() -> None:
    global _loaded
    if not _loaded:
        _loaded = True
        importlib.import_module("app.nodes.executors")


def get_executor(node_type: NodeType) -> Executor | None:
    _load()
    return _EXECUTORS.get(node_type)


def runnable_types() -> frozenset[NodeType]:
    _load()
    return frozenset(_EXECUTORS)


def not_runnable_issues(plan: ExecutionPlan) -> list[FlowIssue]:
    """Nodes of `plan` this server can't execute yet: step types without an executor, and nodes
    attached to agents as tools (tool calling is Phase 4). Empty when the run can start."""
    issues: list[FlowIssue] = []
    for node in plan.nodes.values():
        spec = get_spec(node.type)
        name = f"“{node.name}”"
        if node.role == "tool":
            issues.append(
                FlowIssue(
                    id=f"not-runnable:{node.id}",
                    severity="error",
                    node_id=node.id,
                    message=f"{name}: agents can't use tools yet — this arrives in a later update",
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
