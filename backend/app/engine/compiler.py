"""Graph compiler: turns a saved flow into an execution plan for one run.

A run starts at the trigger that fired. Its plan holds the nodes that run as *steps* (reachable
from that trigger along data edges) and the nodes their agents use as *tools* (attached through
`tool_connection` edges, recursively — an agent attached as a tool can have tools of its own).

The runner (context.md §8k) schedules from the plan alone:
- a step runs once each of its `inputs` has delivered or been skipped; if all were skipped, it is
  skipped too. Inputs only include edges whose sender is part of this run, so a node fed by a
  second trigger's branch doesn't wait for an edge that can never deliver.
- a finished step delivers on the edges of the output handle(s) it chose and skips the rest
  (`outputs` lists every data output handle of the type, even unconnected ones).
- `{{input}}` / `{{<name>.output}}` resolve through `names` (ref first, then id).
- Loops: a Loop's `loop_body` is what it repeats (reachable from its `loop` output without
  passing through it); edges from the body back into the Loop are `back` edges. The Loop starts on
  its other ("entry") inputs, then runs again each time the body comes back.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Literal

from app.core.errors import ApiError
from app.engine.graph import display_name, find_handle, loop_body, node_ref
from app.engine.validation import FlowIssue, validate_flow, with_defaults
from app.nodes.catalog import NodeSpec, get_spec
from app.schemas.flow import Edge, EdgeType, Flow
from app.schemas.node_types import NodeCategory, NodeType


class FlowNotRunnableError(ApiError):
    status_code = 422
    code = "flow_invalid"
    message = "Fix the flow's errors before running it."

    def __init__(self, issues: list[FlowIssue]) -> None:
        errors = [i for i in issues if i.severity == "error"]
        count = f"{len(errors)} error{'s' if len(errors) != 1 else ''}"
        super().__init__(
            f"The flow has {count} to fix before it can run.",
            issues=[i.model_dump(exclude_none=True) for i in errors],
        )
        self.issues = errors


class InvalidTriggerError(ApiError):
    status_code = 422
    code = "invalid_trigger"
    message = "Choose which trigger starts the run."


@dataclass(frozen=True)
class PlanEdge:
    """A data edge of the run, with both handles resolved (never None)."""

    id: str
    source: str
    source_handle: str
    target: str
    target_handle: str
    #: Into a Loop from the body it repeats (not awaited when the Loop first starts).
    back: bool = False


@dataclass(frozen=True)
class PlannedNode:
    id: str
    type: NodeType
    #: The name `{{input}}` keys and references use for this node (its ref, else its id).
    ref: str
    #: What users call it: its label, or its type's label.
    name: str
    #: Config with missing fields filled from catalog defaults.
    data: dict[str, Any]
    #: `step`: scheduled by the runner. `tool`: only invoked by the agent(s) it's attached to.
    role: Literal["step", "tool"]
    #: Incoming data edges from this run's steps (empty for the trigger and for tools).
    inputs: tuple[PlanEdge, ...] = ()
    #: Outgoing data edges per output handle id, in the type's handle order.
    outputs: Mapping[str, tuple[PlanEdge, ...]] = field(default_factory=dict)
    #: Ids of the nodes attached to this agent's Tools handle, in edge order.
    tools: tuple[str, ...] = ()
    #: Loops: the steps it repeats.
    loop_body: frozenset[str] = frozenset()

    @property
    def spec(self) -> NodeSpec:
        return get_spec(self.type)


@dataclass(frozen=True)
class ExecutionPlan:
    flow_id: str | None
    trigger_id: str
    #: Steps and tools of this run, in canvas order.
    nodes: Mapping[str, PlannedNode]
    #: Reference name (ref, or id for older flows) → node id, for every node in the flow.
    names: Mapping[str, str]
    #: Warnings from validation (errors make compiling fail).
    warnings: tuple[FlowIssue, ...] = ()

    @property
    def steps(self) -> list[PlannedNode]:
        return [n for n in self.nodes.values() if n.role == "step"]

    def node(self, node_id: str) -> PlannedNode:
        return self.nodes[node_id]


def compile_flow(flow: Flow, trigger_id: str | None = None) -> ExecutionPlan:
    """Validates `flow` and plans a run starting at `trigger_id` (optional when the flow has
    exactly one trigger). Raises FlowNotRunnableError / InvalidTriggerError."""
    issues = validate_flow(flow)
    if any(i.severity == "error" for i in issues):
        raise FlowNotRunnableError(issues)

    flow = with_defaults(flow)
    triggers = [n.id for n in flow.nodes if get_spec(n.type).category is NodeCategory.TRIGGER]
    if trigger_id is None:
        if len(triggers) != 1:
            raise InvalidTriggerError(
                "This flow has several triggers — choose which one starts the run.",
                triggers=triggers,
            )
        trigger_id = triggers[0]
    elif trigger_id not in triggers:
        raise InvalidTriggerError(
            f"{trigger_id!r} isn't a trigger of this flow.", triggers=triggers
        )

    data_edges = [_plan_edge(e, flow) for e in flow.edges if e.type is EdgeType.DATA]
    tool_edges = [e for e in flow.edges if e.type is EdgeType.TOOL_CONNECTION]

    steps = _reachable(trigger_id, [(e.source, e.target) for e in data_edges])
    links = [(e.source, e.source_handle, e.target) for e in data_edges if e.source in steps]
    bodies = {
        n.id: frozenset(loop_body(n.id, links))
        for n in flow.nodes
        if n.id in steps and n.type is NodeType.LOGIC_LOOP
    }
    data_edges = [
        replace(e, back=True) if e.target in bodies and e.source in bodies[e.target] else e
        for e in data_edges
    ]
    # Validation guarantees no node is both a step and a tool.
    in_run = steps | _reachable_from(steps, [(e.source, e.target) for e in tool_edges])

    nodes: dict[str, PlannedNode] = {}
    for node in flow.nodes:
        if node.id not in in_run:
            continue
        is_step = node.id in steps
        outputs = {
            h.id: tuple(e for e in data_edges if e.source == node.id and e.source_handle == h.id)
            for h in get_spec(node.type).outputs
            if h.kind == "data"
        }
        nodes[node.id] = PlannedNode(
            id=node.id,
            type=node.type,
            ref=node_ref(node),
            name=display_name(node),
            data=node.data,
            role="step" if is_step else "tool",
            inputs=tuple(e for e in data_edges if e.target == node.id and e.source in steps)
            if is_step
            else (),
            outputs=outputs if is_step else {},
            tools=tuple(e.target for e in tool_edges if e.source == node.id),
            loop_body=bodies.get(node.id, frozenset()),
        )

    # Refs win over ids (a ref may only equal its own node's id, so there are no clashes).
    names = {n.id: n.id for n in flow.nodes} | {n.ref: n.id for n in flow.nodes if n.ref}
    return ExecutionPlan(
        flow_id=flow.flow_id,
        trigger_id=trigger_id,
        nodes=nodes,
        names=names,
        warnings=tuple(issues),
    )


def _plan_edge(edge: Edge, flow: Flow) -> PlanEdge:
    # Validation has checked that both handles exist, so these lookups can't fail.
    source = find_handle(flow.node(edge.source).type, edge.source_handle, "source")
    target = find_handle(flow.node(edge.target).type, edge.target_handle, "target")
    assert source is not None and target is not None
    return PlanEdge(edge.id, edge.source, source.id, edge.target, target.id)


def _reachable(start: str, links: list[tuple[str, str]]) -> set[str]:
    return {start} | _reachable_from({start}, links)


def _reachable_from(starts: set[str], links: list[tuple[str, str]]) -> set[str]:
    """Nodes reachable from `starts` along `links` (excluding the starts themselves unless a link
    leads back to them)."""
    seen: set[str] = set()
    queue = list(starts)
    while queue:
        current = queue.pop()
        for source, target in links:
            if source == current and target not in seen:
                seen.add(target)
                queue.append(target)
    return seen
