"""Flow graph schema: the contract between the canvas and the execution engine.

Mirrors React Flow's node/edge shape so the frontend can send its state almost directly. Extra
React Flow UI fields (``measured``, ``selected``, ``dragging``...) are ignored.

This module only enforces *structural* integrity, so half-built flows can still be saved.
Execution rules (single trigger, tool edges must go agent -> tool, ...) live in the engine's
graph compiler.
"""

from collections import Counter
from enum import StrEnum
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.node_types import NodeType

MAX_NODES = 500
MAX_EDGES = 2000


class EdgeType(StrEnum):
    DATA = "data"  # execution flow: source output feeds target
    TOOL_CONNECTION = "tool_connection"  # attaches a tool node to an agent node


class Position(BaseModel):
    x: float
    y: float


class Node(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1)
    type: NodeType
    data: dict[str, Any] = Field(default_factory=dict)
    position: Position


class Edge(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True, serialize_by_alias=True)

    id: str = Field(min_length=1)
    source: str = Field(min_length=1)
    target: str = Field(min_length=1)
    type: EdgeType = EdgeType.DATA
    source_handle: str | None = Field(default=None, alias="sourceHandle")
    target_handle: str | None = Field(default=None, alias="targetHandle")
    animated: bool = False

    @model_validator(mode="before")
    @classmethod
    def _default_type(cls, values: Any) -> Any:
        # React Flow omits/nulls `type` for default edges.
        if isinstance(values, dict) and values.get("type") in (None, "", "default"):
            values = {**values, "type": EdgeType.DATA}
        return values


class Flow(BaseModel):
    model_config = ConfigDict(extra="ignore")

    schema_version: int = 1
    flow_id: str | None = None  # assigned by the backend on first save
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    nodes: list[Node] = Field(default_factory=list, max_length=MAX_NODES)
    edges: list[Edge] = Field(default_factory=list, max_length=MAX_EDGES)

    @model_validator(mode="after")
    def _check_integrity(self) -> Self:
        errors: list[str] = []

        node_ids = [n.id for n in self.nodes]
        if dupes := sorted(i for i, c in Counter(node_ids).items() if c > 1):
            errors.append(f"duplicate node ids: {dupes}")

        if dupes := sorted(i for i, c in Counter(e.id for e in self.edges).items() if c > 1):
            errors.append(f"duplicate edge ids: {dupes}")

        known = set(node_ids)
        seen_connections: set[tuple] = set()
        for edge in self.edges:
            missing = [end for end in (edge.source, edge.target) if end not in known]
            if missing:
                errors.append(f"edge {edge.id!r} references unknown node(s): {missing}")
            if edge.source == edge.target:
                errors.append(f"edge {edge.id!r} connects node {edge.source!r} to itself")
            key = (edge.source, edge.source_handle, edge.target, edge.target_handle, edge.type)
            if key in seen_connections:
                errors.append(f"edge {edge.id!r} duplicates an existing connection")
            seen_connections.add(key)

        if errors:
            raise ValueError("; ".join(errors))
        return self

    def node(self, node_id: str) -> Node:
        return next(n for n in self.nodes if n.id == node_id)
