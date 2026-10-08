"""Helpers for building flows in tests."""

from typing import Any

from app.schemas.flow import Flow


def node(id: str, type: str, ref: str | None = None, **data: Any) -> dict[str, Any]:
    return {"id": id, "type": type, "ref": ref, "data": data, "position": {"x": 0, "y": 0}}


def edge(source: str, target: str, handle: str | None = "out", **kw: Any) -> dict[str, Any]:
    return {
        "id": f"{source}-{handle}-{target}",
        "source": source,
        "target": target,
        "sourceHandle": handle,
        "targetHandle": "in",
        **kw,
    }


def tool_edge(agent: str, tool: str) -> dict[str, Any]:
    return edge(agent, tool, "tools", type="tool_connection", targetHandle="tool")


def flow(nodes: list[dict], edges: list[dict], **kw: Any) -> Flow:
    return Flow.model_validate({"flow_id": "f1", "name": "f", "nodes": nodes, "edges": edges, **kw})
