"""Guards against the frontend's and backend's shared enums drifting apart."""

import re
from pathlib import Path

import pytest

from app.schemas import EdgeType, NodeCategory, NodeType, knowledge
from app.schemas.credentials import CredentialProvider
from app.schemas.flow import MAX_DESCRIPTION_LENGTH, MAX_EDGES, MAX_NAME_LENGTH, MAX_NODES

TYPES_DIR = Path(__file__).resolve().parents[2] / "frontend" / "src" / "types"
FRONTEND_TYPES = TYPES_DIR / "flow.ts"

pytestmark = pytest.mark.skipif(not FRONTEND_TYPES.exists(), reason="frontend not checked out")


def ts_string_array(name: str, file: Path = FRONTEND_TYPES) -> list[str]:
    source = file.read_text(encoding="utf-8")
    match = re.search(rf"export const {name} = \[(.*?)\] as const;", source, re.DOTALL)
    assert match, f"{name} not found in {file}"
    body = re.sub(r"//.*", "", match.group(1))
    return re.findall(r'"([^"]+)"', body)


def ts_number(name: str, file: Path = FRONTEND_TYPES) -> int:
    source = file.read_text(encoding="utf-8")
    match = re.search(rf"export const {name} = ([0-9_]+);", source)
    assert match, f"{name} not found in {file}"
    return int(match.group(1))


def test_node_types_match() -> None:
    assert ts_string_array("NODE_TYPES") == [t.value for t in NodeType]


def test_node_categories_match() -> None:
    assert ts_string_array("NODE_CATEGORIES") == [c.value for c in NodeCategory]


def test_edge_types_match() -> None:
    assert ts_string_array("EDGE_TYPES") == [t.value for t in EdgeType]


def test_credential_providers_match() -> None:
    assert ts_string_array("CREDENTIAL_PROVIDERS", TYPES_DIR / "credentials.ts") == [
        p.value for p in CredentialProvider
    ]


def test_flow_limits_match() -> None:
    assert ts_number("MAX_FLOW_NAME_LENGTH") == MAX_NAME_LENGTH
    assert ts_number("MAX_FLOW_DESCRIPTION_LENGTH") == MAX_DESCRIPTION_LENGTH
    assert ts_number("MAX_FLOW_NODES") == MAX_NODES
    assert ts_number("MAX_FLOW_EDGES") == MAX_EDGES


def test_knowledge_base_limits_match() -> None:
    file = TYPES_DIR / "knowledge.ts"
    assert ts_number("MAX_KB_NAME_LENGTH", file) == knowledge.MAX_NAME_LENGTH
    assert ts_number("MAX_KB_DESCRIPTION_LENGTH", file) == knowledge.MAX_DESCRIPTION_LENGTH
    names = (
        "DEFAULT_CHUNK_SIZE",
        "DEFAULT_CHUNK_OVERLAP",
        "MIN_CHUNK_SIZE",
        "MAX_CHUNK_SIZE",
        "MAX_DOCUMENT_BYTES",
    )
    for name in names:
        assert ts_number(name, file) == getattr(knowledge, name), name
