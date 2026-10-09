"""Pure graph helpers shared by flow validation and the compiler.

Ports of the frontend's graph helpers (frontend/src/lib/flow/graph.ts, refs.ts, validate.ts) —
keep the behaviour identical, `shared/validation-cases.json` tests both sides.
"""

import copy
from collections.abc import Iterable, Sequence
from typing import Any, Literal

from app.nodes.catalog import HandleSpec, get_spec
from app.schemas.flow import Edge, EdgeType, Node
from app.schemas.node_types import NodeType


def with_field_defaults(node_type: NodeType, data: dict[str, Any]) -> dict[str, Any]:
    """Fills in config fields a node type gained after the node was saved with their defaults.
    Existing values, and keys the catalog doesn't know, are kept as they are."""
    spec = get_spec(node_type)
    missing = [f.key for f in spec.fields if f.key not in data]
    if not missing:
        return data
    return {**data, **{key: copy.deepcopy(spec.default_data[key]) for key in missing}}


def display_name(node: Node) -> str:
    """The node's custom label, or its type's label."""
    label = node.data.get("label")
    if isinstance(label, str) and label.strip():
        return label.strip()
    return get_spec(node.type).label


def node_ref(node: Node) -> str:
    """The name templates use for the node: its ref, or its id for flows saved before refs."""
    return node.ref or node.id


def find_handle(
    node_type: NodeType, handle_id: str | None, side: Literal["source", "target"]
) -> HandleSpec | None:
    """The handle an edge end attaches to. React Flow reports a null handle id when a node has a
    single unnamed handle, which means the first one."""
    spec = get_spec(node_type)
    handles = spec.outputs if side == "source" else spec.inputs
    if not handle_id:
        return handles[0] if handles else None
    return next((h for h in handles if h.id == handle_id), None)


def find_referenced_node(name: str, nodes: Sequence[Node]) -> Node | None:
    """The node a template reference points at: by ref, or by id for older flows."""
    return next((n for n in nodes if n.ref == name), None) or next(
        (n for n in nodes if n.id == name), None
    )


def upstream_node_ids(node_id: str, edges: Sequence[Edge]) -> list[str]:
    """Ids of the nodes whose output is available when `node_id` runs: everything upstream along
    data edges, nearest first. A tool runs inside the agent it's attached to, so it sees what that
    agent sees (but not the agent's own output, which doesn't exist yet). Loops are handled."""
    agents = [e.source for e in edges if e.type is EdgeType.TOOL_CONNECTION and e.target == node_id]
    result: list[str] = []
    seen = {node_id, *agents}
    queue = [node_id, *agents]
    while queue:
        current = queue.pop(0)
        for e in edges:
            if e.type is EdgeType.DATA and e.target == current and e.source not in seen:
                seen.add(e.source)
                result.append(e.source)
                queue.append(e.source)
    # In a loop the node is its own ancestor; never allow a self-reference.
    return [i for i in result if i != node_id]


def loop_body(loop_id: str, links: Iterable[tuple[str, str, str]]) -> set[str]:
    """The nodes a Loop repeats: everything reachable from its `loop` output without passing
    through the Loop itself. `links` are data edges as (source, resolved source handle, target)."""
    links = list(links)
    body: set[str] = set()
    queue = [t for s, h, t in links if s == loop_id and h == "loop" and t != loop_id]
    while queue:
        current = queue.pop()
        if current in body:
            continue
        body.add(current)
        queue.extend(t for s, _, t in links if s == current and t != loop_id)
    return body


def resolved_links(nodes: Sequence[Node], edges: Iterable[Edge]) -> list[tuple[str, str, str]]:
    """Data edges as (source, source handle with null resolved, target)."""
    types = {n.id: n.type for n in nodes}
    links = []
    for e in edges:
        if e.type is not EdgeType.DATA or e.source not in types:
            continue
        handle = find_handle(types[e.source], e.source_handle, "source")
        links.append((e.source, handle.id if handle else e.source_handle or "", e.target))
    return links


def cycles(edges: Iterable[Edge]) -> list[set[str]]:
    """Groups of nodes that lie on a cycle of `edges` (strongly connected components with more
    than one node; the schema forbids self-loops). Iterative Kosaraju, O(nodes + edges)."""
    forward: dict[str, list[str]] = {}
    backward: dict[str, list[str]] = {}
    for e in edges:
        forward.setdefault(e.source, []).append(e.target)
        forward.setdefault(e.target, [])
        backward.setdefault(e.target, []).append(e.source)
        backward.setdefault(e.source, [])

    # Pass 1: nodes in order of DFS completion.
    finished: list[str] = []
    visited: set[str] = set()
    for start in forward:
        if start in visited:
            continue
        visited.add(start)
        stack = [(start, iter(forward[start]))]
        while stack:
            current, successors = stack[-1]
            nxt = next((s for s in successors if s not in visited), None)
            if nxt is None:
                stack.pop()
                finished.append(current)
            else:
                visited.add(nxt)
                stack.append((nxt, iter(forward[nxt])))

    # Pass 2: walk the reversed graph in reverse completion order; each walk is one component.
    assigned: set[str] = set()
    components: list[set[str]] = []
    for start in reversed(finished):
        if start in assigned:
            continue
        component = {start}
        assigned.add(start)
        queue = [start]
        while queue:
            for prev in backward[queue.pop()]:
                if prev not in assigned:
                    assigned.add(prev)
                    component.add(prev)
                    queue.append(prev)
        if len(component) > 1:
            components.append(component)
    return components
