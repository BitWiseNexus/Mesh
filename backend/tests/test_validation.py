import json
from pathlib import Path
from typing import Any

import pytest

from app.engine.graph import cycles, upstream_node_ids
from app.engine.validation import FlowIssue, validate_flow, with_defaults
from app.schemas.flow import Edge, Flow

# Shared with the frontend's validateFlow tests — both must report exactly the same issues.
CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "shared" / "validation-cases.json").read_text("utf-8")
)["cases"]


def load_case(case: dict[str, Any]) -> Flow:
    """A shared case as a saved flow (the format is described in the JSON's $comment)."""
    edges = []
    for e in case["edges"]:
        tool = e.get("type") == "tool_connection"
        source_handle = e.get("handle", "tools" if tool else "out")
        edges.append(
            {
                "id": e.get("id", f"{e['from']}-{source_handle}-{e['to']}"),
                "source": e["from"],
                "target": e["to"],
                "type": e.get("type", "data"),
                "sourceHandle": source_handle,
                "targetHandle": e.get("targetHandle", "tool" if tool else "in"),
            }
        )
    nodes = [
        {
            "id": n["id"],
            "type": n["type"],
            "ref": n.get("ref", n["id"]),
            "data": n.get("data", {}),
            "position": {"x": 0, "y": 0},
        }
        for n in case["nodes"]
    ]
    return Flow.model_validate({"name": case["name"], "nodes": nodes, "edges": edges})


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_shared_cases(case: dict[str, Any]) -> None:
    issues = validate_flow(load_case(case))
    # Errors first: the list is exactly the errors followed by the warnings.
    assert [(i.severity, i.id) for i in issues] == [
        *(("error", i) for i in case["errors"]),
        *(("warning", i) for i in case["warnings"]),
    ]
    by_id = {i.id: i for i in issues}
    for issue_id, message in case.get("messages", {}).items():
        assert by_id[issue_id].message == message


def test_issues_serialise_like_the_frontend() -> None:
    issue = FlowIssue(id="required:a:url", severity="error", message="m", node_id="a", field="url")
    assert issue.model_dump(exclude_none=True) == {
        "id": "required:a:url",
        "severity": "error",
        "message": "m",
        "nodeId": "a",
        "field": "url",
    }
    [no_trigger] = validate_flow(Flow(name="empty"))
    assert no_trigger.fix == "add_trigger"


def test_issues_point_at_their_node_and_field() -> None:
    case = next(c for c in CASES if c["name"].startswith("empty required field"))
    [required, unreachable] = validate_flow(load_case(case))
    assert (required.node_id, required.field) == ("api", "url")
    assert (unreachable.node_id, unreachable.field) == ("orphan", None)


def test_with_defaults_fills_only_missing_fields() -> None:
    flow = Flow.model_validate(
        {
            "name": "f",
            "nodes": [
                {
                    "id": "a",
                    "type": "agent_node",
                    "data": {"model": "m", "custom": 1},
                    "position": {"x": 0, "y": 0},
                }
            ],
        }
    )
    data = with_defaults(flow).nodes[0].data
    assert data["model"] == "m" and data["custom"] == 1
    assert data["prompt"] == "{{input}}" and data["temperature"] == 0.7
    assert flow.nodes[0].data == {"model": "m", "custom": 1}  # the input isn't modified


def _edges(*pairs: str) -> list[Edge]:
    return [Edge(id=p, source=p[0], target=p[1]) for p in pairs]


def test_cycles_finds_each_component() -> None:
    # a→b→c→a and d⇄e are cycles; f hangs off the first one.
    found = cycles(_edges("ab", "bc", "ca", "cf", "de", "ed"))
    assert sorted(sorted(c) for c in found) == [["a", "b", "c"], ["d", "e"]]
    assert cycles(_edges("ab", "bc", "ac")) == []


def test_cycles_handles_long_chains_without_recursion() -> None:
    names = [f"n{i}" for i in range(3000)]
    edges = [Edge(id=f"e{i}", source=names[i], target=names[i + 1]) for i in range(2999)]
    edges.append(Edge(id="back", source=names[-1], target=names[0]))
    assert [len(c) for c in cycles(edges)] == [3000]


def test_upstream_is_nearest_first_and_excludes_self_in_loops() -> None:
    assert upstream_node_ids("c", _edges("ab", "bc")) == ["b", "a"]
    assert upstream_node_ids("a", _edges("ab", "ba")) == ["b"]
