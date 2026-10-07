"""Guards against the frontend and backend node catalogs drifting apart."""

import re
from pathlib import Path

import pytest

from app.schemas import EdgeType, NodeCategory, NodeType

FRONTEND_TYPES = Path(__file__).resolve().parents[2] / "frontend" / "src" / "types" / "flow.ts"

pytestmark = pytest.mark.skipif(not FRONTEND_TYPES.exists(), reason="frontend not checked out")


def ts_string_array(name: str) -> list[str]:
    source = FRONTEND_TYPES.read_text(encoding="utf-8")
    match = re.search(rf"export const {name} = \[(.*?)\] as const;", source, re.DOTALL)
    assert match, f"{name} not found in {FRONTEND_TYPES}"
    body = re.sub(r"//.*", "", match.group(1))
    return re.findall(r'"([^"]+)"', body)


def test_node_types_match() -> None:
    assert ts_string_array("NODE_TYPES") == [t.value for t in NodeType]


def test_node_categories_match() -> None:
    assert ts_string_array("NODE_CATEGORIES") == [c.value for c in NodeCategory]


def test_edge_types_match() -> None:
    assert ts_string_array("EDGE_TYPES") == [t.value for t in EdgeType]
