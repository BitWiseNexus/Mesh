"""Flow validation before a run: the backend twin of the editor's live validation.

Must report exactly what frontend/src/lib/flow/validate.ts reports (same ids, severities and
messages), so the editor shows every problem that makes the backend refuse a run. Both are tested
against `shared/validation-cases.json` — add a case there when changing a rule on either side.

- error   → the flow can't run
- warning → the flow runs, but part of it will never execute or is likely a mistake
"""

import math
from collections.abc import Callable, Sequence
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.engine.graph import (
    cycles,
    display_name,
    find_handle,
    find_referenced_node,
    node_ref,
    upstream_node_ids,
    with_field_defaults,
)
from app.engine.references import InputPart, InvalidPart, RefPart, parse_template
from app.nodes.catalog import FieldSpec, get_spec
from app.schemas.flow import Edge, EdgeType, Flow, Node
from app.schemas.node_types import NodeCategory, NodeType


class FlowIssue(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, serialize_by_alias=True, frozen=True
    )

    #: Stable id, e.g. `unreachable:node_1a2b3c4d`.
    id: str
    severity: Literal["error", "warning"]
    message: str
    node_id: str | None = None
    #: Config field the issue refers to.
    field: str | None = None
    #: A one-click fix the editor can offer.
    fix: Literal["add_trigger"] | None = None


def _is_empty(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "") or value == []


def _fmt(number: float) -> str:
    """Formats a number like JavaScript's template strings do (2, not 2.0)."""
    return str(int(number)) if float(number).is_integer() else str(number)


def is_missing_required(field: FieldSpec, data: dict[str, Any]) -> bool:
    return field.required and _is_empty(data.get(field.key))


def field_value_problem(field: FieldSpec, value: Any) -> str | None:
    """Problem with a non-empty field value (type, range, allowed options), or None."""
    if _is_empty(value):
        return None  # emptiness is handled by `required`
    match field.kind:
        case "number":
            is_number = isinstance(value, int | float) and not isinstance(value, bool)
            if not is_number or not math.isfinite(value):
                return "must be a number"
            low, high = field.min, field.max
            if low is not None and high is not None and not low <= value <= high:
                return f"must be between {_fmt(low)} and {_fmt(high)}"
            if low is not None and value < low:
                return f"must be at least {_fmt(low)}"
            if high is not None and value > high:
                return f"must be at most {_fmt(high)}"
            return None
        case "json":
            if field.shape == "object" and not isinstance(value, dict):
                return "must be a JSON object"
            if field.shape == "array" and not isinstance(value, list):
                return "must be a JSON array"
            return None
        case "select":
            return (
                None
                if any(o.value == value for o in field.options or [])
                else ("has an unsupported value")
            )
        case "switch":
            return None if isinstance(value, bool) else "must be on or off"
        case "knowledge_base":
            return None if isinstance(value, str) else "must be a knowledge base"
        case _:
            return None if isinstance(value, str) else "must be text"


def with_defaults(flow: Flow) -> Flow:
    """The flow with every node's missing config fields filled from catalog defaults (what the
    editor does when it loads a flow, and what validation and execution see)."""
    nodes = [n.model_copy(update={"data": with_field_defaults(n.type, n.data)}) for n in flow.nodes]
    return flow.model_copy(update={"nodes": nodes})


def validate_flow(flow: Flow) -> list[FlowIssue]:
    """All problems with `flow`, errors first, otherwise in canvas order."""
    flow = with_defaults(flow)
    nodes, edges = flow.nodes, flow.edges
    by_id = {n.id: n for n in nodes}
    issues: list[FlowIssue] = []

    def name(n: Node) -> str:
        return f"“{display_name(n)}”"

    def error(id: str, message: str, **kw: Any) -> None:
        issues.append(FlowIssue(id=id, severity="error", message=message, **kw))

    def warning(id: str, message: str, **kw: Any) -> None:
        issues.append(FlowIssue(id=id, severity="warning", message=message, **kw))

    triggers = [n for n in nodes if get_spec(n.type).category is NodeCategory.TRIGGER]
    if not triggers:
        error("no-trigger", "Add a trigger so the flow has a starting point", fix="add_trigger")

    # Reachable = on an execution path from a trigger, or attached as a tool to such a node.
    reachable = {n.id for n in triggers}
    queue = list(reachable)
    while queue:
        current = queue.pop(0)
        for e in edges:
            if e.source == current and e.target not in reachable:
                reachable.add(e.target)
                queue.append(e.target)
    tool_edges = [e for e in edges if e.type is EdgeType.TOOL_CONNECTION]
    data_edges = [e for e in edges if e.type is EdgeType.DATA]
    attached_tools = {e.target for e in tool_edges}
    in_tool_cycle = {i for c in cycles(tool_edges) for i in c}
    # Data cycles are only allowed through a Loop node, which bounds how often they repeat.
    unbounded_cycle = {
        i
        for c in cycles(data_edges)
        if not any(by_id[i].type is NodeType.LOGIC_LOOP for i in c)
        for i in c
    }

    for node in nodes:
        spec = get_spec(node.type)
        at = {"node_id": node.id}

        if spec.deprecated:
            error(f"deprecated:{node.id}", f"{name(node)}: {spec.deprecated}", **at)
        elif spec.coming_soon:
            error(
                f"unavailable:{node.id}",
                f"{name(node)}: {spec.label} nodes aren't available yet",
                **at,
            )

        if spec.category is NodeCategory.TOOL and node.id not in attached_tools:
            warning(
                f"unattached:{node.id}",
                f"{name(node)} isn't attached to an agent's Tools handle",
                **at,
            )
        elif triggers and node.id not in reachable:
            warning(
                f"unreachable:{node.id}",
                f"{name(node)} isn't connected to a trigger and will never run",
                **at,
            )

        # A node used as a tool is invoked by its agent; it can't also be a step in the flow.
        if node.id in attached_tools and any(node.id in (e.source, e.target) for e in data_edges):
            error(
                f"tool-and-step:{node.id}",
                f"{name(node)} is attached to an agent as a tool, so it can't also be connected "
                "as a step",
                **at,
            )

        if node.id in in_tool_cycle:
            error(
                f"tool-cycle:{node.id}",
                f"{name(node)} is part of a loop of tool attachments (agents can't use each other "
                "in a circle)",
                **at,
            )

        if node.id in unbounded_cycle:
            error(
                f"cycle-without-loop:{node.id}",
                f"{name(node)} is part of a cycle that doesn't go through a Loop node, so it "
                "would never finish",
                **at,
            )

        if node.type is NodeType.LOGIC_LOOP and not any(
            e.source == node.id and e.source_handle == "loop" for e in edges
        ):
            warning(
                f"empty-loop:{node.id}",
                f"{name(node)} has nothing connected to its Loop output",
                **at,
            )

        for field in spec.fields:
            value = node.data.get(field.key)
            at_field = {**at, "field": field.key}
            if is_missing_required(field, node.data):
                error(
                    f"required:{node.id}:{field.key}",
                    f"{name(node)}: {field.label} is required",
                    **at_field,
                )
                continue
            if problem := field_value_problem(field, value):
                error(
                    f"invalid:{node.id}:{field.key}",
                    f"{name(node)}: {field.label} {problem}",
                    **at_field,
                )
                continue
            if field.templated and isinstance(value, str):
                if ref_problem := _reference_problem(value, node, nodes, edges, name):
                    error(
                        f"reference:{node.id}:{field.key}",
                        f"{name(node)}: {field.label} {ref_problem}",
                        **at_field,
                    )
                elif _ambiguous_input(value, node, by_id, data_edges):
                    warning(
                        f"ambiguous-input:{node.id}:{field.key}",
                        f"{name(node)}: {field.label} uses {{{{input}}}}, but several nodes feed "
                        "into it, so {{input}} holds all their outputs — pick one with Insert",
                        **at_field,
                    )

    # Connections the editor can't draw, but an imported file or API client can send.
    for e in edges:
        if not _connection_fits(e, by_id):
            error(
                f"invalid-connection:{e.id}",
                f"The connection from {name(by_id[e.source])} to {name(by_id[e.target])} doesn't "
                "fit their handles — delete it and connect them again",
                node_id=e.target,
            )

    # Errors first, otherwise keep canvas order (sorted() is stable).
    return sorted(issues, key=lambda i: i.severity == "warning")


def _connection_fits(edge: Edge, by_id: dict[str, Node]) -> bool:
    """The edge joins two existing handles of the kind its type needs (data ↔ data for `data`
    edges, an agent's Tools handle ↔ a tool handle for `tool_connection`)."""
    source = find_handle(by_id[edge.source].type, edge.source_handle, "source")
    target = find_handle(by_id[edge.target].type, edge.target_handle, "target")
    kind = "tool" if edge.type is EdgeType.TOOL_CONNECTION else "data"
    return source is not None and target is not None and source.kind == target.kind == kind


def _reference_problem(
    value: str,
    node: Node,
    nodes: Sequence[Node],
    edges: Sequence[Edge],
    name: Callable[[Node], str],
) -> str | None:
    """The first problem with the {{references}} in a templated value, or None. A reference must
    be well-formed and point at a node whose output exists by the time this node runs."""
    upstream: set[str] | None = None  # computed lazily: most fields have no references
    for part in parse_template(value):
        if isinstance(part, InvalidPart):
            return f"has an invalid reference {part.raw}"
        if not isinstance(part, RefPart):
            continue
        token = f"{{{{{part.node}.output}}}}"
        target = find_referenced_node(part.node, nodes)
        if target is None:
            return f"refers to {token}, but no node is called “{part.node}”"
        if target.id == node.id:
            return f"refers to this node's own output ({token})"
        if upstream is None:
            upstream = set(upstream_node_ids(node.id, edges))
        if target.id not in upstream:
            return f"refers to {name(target)}, which doesn't run before this node"
    return None


def _ambiguous_input(
    value: str, node: Node, by_id: dict[str, Node], data_edges: Sequence[Edge]
) -> bool:
    """With several incoming connections, `{{input}}` is an object keyed by each sender's ref. A
    bare `{{input}}` (or `{{input.x}}` where x isn't a sender) is then almost certainly not what
    was meant."""
    senders = {e.source for e in data_edges if e.target == node.id}
    if len(senders) < 2:
        return False
    sender_refs = {node_ref(by_id[s]) for s in senders}
    return any(
        isinstance(p, InputPart) and (not p.path or p.path[0] not in sender_refs)
        for p in parse_template(value)
    )
