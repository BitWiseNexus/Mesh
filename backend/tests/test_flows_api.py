"""Flows API against the Firestore emulator (skipped when it isn't running)."""

import urllib.error
import urllib.request
from collections.abc import Callable, Iterator

import pytest
from fastapi.testclient import TestClient

from app.core.auth import AuthUser, get_current_user
from app.core.firebase import get_db
from app.main import app
from tests.conftest import FIRESTORE_EMULATOR, requires_firestore_emulator

CLEAR_URL = f"{FIRESTORE_EMULATOR}/emulator/v1/projects/demo-mesh/databases/(default)/documents"


pytestmark = requires_firestore_emulator

SPEC_FLOW = {
    "name": "Support Lead AI Assistant",
    "nodes": [
        {"id": "node_1", "type": "trigger_manual", "data": {}, "position": {"x": 0, "y": 0}},
        {
            "id": "node_2",
            "type": "agent_node",
            "data": {"model": "gpt-4o", "system_prompt": "Parse leads."},
            "position": {"x": 400, "y": 0},
        },
        {
            "id": "node_3",
            "type": "tool_web_search",
            "data": {"provider": "tavily"},
            "position": {"x": 400, "y": 240},
        },
    ],
    "edges": [
        {"id": "e1", "source": "node_1", "target": "node_2", "sourceHandle": "out"},
        {
            "id": "e2",
            "source": "node_2",
            "target": "node_3",
            "type": "tool_connection",
            "sourceHandle": "tools",
            "targetHandle": "tool",
        },
    ],
}


@pytest.fixture
def client() -> Iterator[TestClient]:
    urllib.request.urlopen(urllib.request.Request(CLEAR_URL, method="DELETE"), timeout=5)
    # The async Firestore client binds to the event loop it was created on; TestClient runs a
    # fresh loop per instance, so build a fresh client per test.
    get_db.cache_clear()
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    get_db.cache_clear()


@pytest.fixture
def as_user() -> Callable[[str], None]:
    def switch(uid: str) -> None:
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid=uid)

    return switch


def create(client: TestClient, **overrides) -> dict:
    response = client.post("/flows", json={**SPEC_FLOW, **overrides})
    assert response.status_code == 201, response.text
    return response.json()


def test_requires_authentication(client: TestClient) -> None:
    assert client.get("/flows").status_code == 401


def test_create_and_get_round_trip(client, as_user) -> None:
    as_user("alice")
    created = create(client)
    assert created["flow_id"]
    assert created["version"] == 1
    assert created["created_at"] == created["updated_at"]
    assert created["edges"][1] == {
        "id": "e2",
        "source": "node_2",
        "target": "node_3",
        "type": "tool_connection",
        "sourceHandle": "tools",
        "targetHandle": "tool",
        "animated": False,
    }

    fetched = client.get(f"/flows/{created['flow_id']}").json()
    assert fetched == created


def test_list_is_owner_scoped_and_newest_first(client, as_user) -> None:
    as_user("alice")
    first = create(client, name="First")
    second = create(client, name="Second")
    client.patch(f"/flows/{first['flow_id']}", json={"name": "First (edited)"})
    as_user("bob")
    create(client, name="Bob's flow")

    as_user("alice")
    flows = client.get("/flows").json()
    assert [f["name"] for f in flows] == ["First (edited)", "Second"]
    assert flows[1] == {
        "flow_id": second["flow_id"],
        "name": "Second",
        "description": "",
        "node_count": 3,
        "created_at": second["created_at"],
        "updated_at": second["updated_at"],
        "version": 1,
    }


@pytest.mark.parametrize(
    ("method", "suffix", "body"),
    [
        ("GET", "", None),
        ("PUT", "", SPEC_FLOW),
        ("PATCH", "", {"name": "hijack"}),
        ("DELETE", "", None),
        ("POST", "/duplicate", None),
    ],
)
def test_other_users_flows_look_missing(client, as_user, method, suffix, body) -> None:
    as_user("alice")
    flow_id = create(client)["flow_id"]
    as_user("mallory")
    response = client.request(method, f"/flows/{flow_id}{suffix}", json=body)
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "flow_not_found"

    as_user("alice")  # untouched
    assert client.get(f"/flows/{flow_id}").json()["version"] == 1


def test_replace_bumps_version_and_detects_conflicts(client, as_user) -> None:
    as_user("alice")
    flow = create(client)
    flow_id = flow["flow_id"]
    updated = {**SPEC_FLOW, "name": "Renamed", "nodes": SPEC_FLOW["nodes"][:1], "edges": []}

    ok = client.put(f"/flows/{flow_id}", json={**updated, "expected_version": 1})
    assert ok.status_code == 200
    assert ok.json()["version"] == 2
    assert ok.json()["name"] == "Renamed"
    assert len(ok.json()["nodes"]) == 1
    assert ok.json()["updated_at"] > flow["updated_at"]

    # A second tab still thinks it's at version 1.
    stale = client.put(f"/flows/{flow_id}", json={**SPEC_FLOW, "expected_version": 1})
    assert stale.status_code == 409
    assert stale.json()["detail"] == {
        "code": "version_conflict",
        "message": "This flow was changed elsewhere. Reload it to get the latest version.",
        "current_version": 2,
    }

    # Without expected_version it's last-write-wins.
    assert client.put(f"/flows/{flow_id}", json=SPEC_FLOW).json()["version"] == 3


def test_patch_renames_without_touching_the_graph(client, as_user) -> None:
    as_user("alice")
    flow = create(client)
    patched = client.patch(
        f"/flows/{flow['flow_id']}", json={"name": "New name", "description": "Desc"}
    ).json()
    assert (patched["name"], patched["description"], patched["version"]) == ("New name", "Desc", 2)
    assert patched["nodes"] == flow["nodes"]


def test_delete(client, as_user) -> None:
    as_user("alice")
    flow_id = create(client)["flow_id"]
    assert client.delete(f"/flows/{flow_id}").status_code == 204
    assert client.get(f"/flows/{flow_id}").status_code == 404
    assert client.delete(f"/flows/{flow_id}").status_code == 404


def test_duplicate(client, as_user) -> None:
    as_user("alice")
    original = create(client)
    copy = client.post(f"/flows/{original['flow_id']}/duplicate")
    assert copy.status_code == 201
    body = copy.json()
    assert body["flow_id"] != original["flow_id"]
    assert body["name"] == "Support Lead AI Assistant (copy)"
    assert body["version"] == 1
    assert body["nodes"] == original["nodes"]


def test_node_config_with_nested_arrays_survives(client, as_user) -> None:
    # Firestore can't store arrays inside arrays natively; the JSON graph field can.
    as_user("alice")
    nodes = [{**SPEC_FLOW["nodes"][0], "data": {"matrix": [[1, 2], [3, [4]]]}}]
    flow = create(client, nodes=nodes, edges=[])
    assert client.get(f"/flows/{flow['flow_id']}").json()["nodes"][0]["data"] == {
        "matrix": [[1, 2], [3, [4]]]
    }


def test_rejects_invalid_flows(client, as_user) -> None:
    as_user("alice")
    dangling = {**SPEC_FLOW, "edges": [{"id": "x", "source": "node_1", "target": "ghost"}]}
    assert client.post("/flows", json=dangling).status_code == 422

    too_many = [
        {"id": f"n{i}", "type": "agent_node", "position": {"x": 0, "y": 0}} for i in range(501)
    ]
    assert client.post("/flows", json={"name": "big", "nodes": too_many}).status_code == 422

    assert client.get("/flows/__reserved__").status_code == 422


def test_rejects_flows_over_the_size_limit(client, as_user) -> None:
    as_user("alice")
    huge = [{**SPEC_FLOW["nodes"][1], "data": {"system_prompt": "x" * 950_000}}]
    response = client.post("/flows", json={"name": "huge", "nodes": huge, "edges": []})
    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "flow_too_large"
