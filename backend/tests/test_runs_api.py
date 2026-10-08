"""Runs API against the Firestore emulator (skipped when it isn't running)."""

import json
import time
import urllib.request
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api import runs as runs_api
from app.core.auth import AuthUser, get_current_user
from app.core.config import Settings
from app.core.firebase import get_db
from app.main import app
from app.repositories.runs import RunRepository
from tests.conftest import FIRESTORE_EMULATOR, requires_firestore_emulator
from tests.flows import edge, node

CLEAR_URL = f"{FIRESTORE_EMULATOR}/emulator/v1/projects/demo-mesh/databases/(default)/documents"

pytestmark = requires_firestore_emulator

AGENT_FLOW = {
    "name": "Echo",
    "nodes": [
        node("t", "trigger_manual", "trigger", input="hello from the trigger"),
        node("a", "agent_node", "agent", model="mock/echo", prompt="Echo: {{input}}"),
        node("out", "output_display", "result"),
    ],
    "edges": [edge("t", "a"), edge("a", "out")],
}


@pytest.fixture
def client() -> Iterator[TestClient]:
    urllib.request.urlopen(urllib.request.Request(CLEAR_URL, method="DELETE"), timeout=5)
    get_db.cache_clear()  # the async client binds to the TestClient's event loop
    with TestClient(app) as test_client:
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="alice")
        yield test_client
    app.dependency_overrides.clear()
    get_db.cache_clear()


@pytest.fixture
def as_user() -> Callable[[str], None]:
    def switch(uid: str) -> None:
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid=uid)

    return switch


def create_flow(client: TestClient, flow: dict[str, Any] = AGENT_FLOW) -> str:
    response = client.post("/flows", json=flow)
    assert response.status_code == 201, response.text
    return response.json()["flow_id"]


def start(client: TestClient, flow_id: str, **body: Any) -> dict[str, Any]:
    response = client.post(f"/flows/{flow_id}/runs", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def read_stream(client: TestClient, run_id: str, **headers: str) -> list[dict[str, Any]]:
    """All events of the stream, with their SSE id/event fields checked."""
    received: list[dict[str, Any]] = []
    with client.stream("GET", f"/runs/{run_id}/stream", headers=headers) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        fields: dict[str, str] = {}
        for line in response.iter_lines():
            if line == "":
                if "data" in fields:
                    event = json.loads(fields["data"])
                    assert fields["event"] == event["type"]
                    if "id" in fields:
                        assert int(fields["id"]) == event["seq"]
                    received.append(event)
                fields = {}
            elif not line.startswith(":"):
                key, _, value = line.partition(": ")
                fields[key] = value
    return received


def wait_for_status(client: TestClient, run_id: str, *statuses: str) -> dict[str, Any]:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        run = client.get(f"/runs/{run_id}").json()
        if run["status"] in statuses:
            return run
        time.sleep(0.05)
    raise AssertionError(f"run never reached {statuses}: {run}")


def test_runs_a_flow_and_streams_it(client: TestClient) -> None:
    flow_id = create_flow(client)
    run = start(client, flow_id, input="hi there")
    assert run["status"] == "queued" and run["flow_version"] == 1 and run["trigger_id"] == "t"
    assert run["input"] == "hi there"

    stream = read_stream(client, run["run_id"])
    assert [e["type"] for e in stream if e["type"] != "token"] == [
        "run_started",
        "node_started",
        "node_finished",
        "node_started",
        "node_finished",
        "node_started",
        "node_finished",
        "run_finished",
    ]
    assert "".join(e["text"] for e in stream if e["type"] == "token") == "Echo: hi there"
    assert stream[-1]["status"] == "succeeded"
    assert [e["seq"] for e in stream] == list(range(1, len(stream) + 1))

    record = wait_for_status(client, run["run_id"], "succeeded")
    assert record["started_at"] and record["finished_at"] and record["error"] is None
    assert {k: (v["status"], v["output"]) for k, v in record["node_states"].items()} == {
        "t": ("succeeded", "hi there"),
        "a": ("succeeded", "Echo: hi there"),
        "out": ("succeeded", "Echo: hi there"),
    }
    assert record["node_states"]["a"]["handles"] == ["out"]


def test_the_trigger_default_input_is_used_without_run_input(client: TestClient) -> None:
    run = start(client, create_flow(client))
    read_stream(client, run["run_id"])
    record = wait_for_status(client, run["run_id"], "succeeded")
    assert record["node_states"]["out"]["output"] == "Echo: hello from the trigger"


def test_streams_resume_after_the_last_event_id(client: TestClient) -> None:
    run = start(client, create_flow(client))
    full = read_stream(client, run["run_id"])
    resumed = read_stream(client, run["run_id"], **{"Last-Event-ID": "3"})
    assert resumed == full[3:]


def test_finished_runs_that_are_no_longer_live_stream_a_snapshot(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(app.state.runs.settings, "run_events_retention_seconds", 0)
    run = start(client, create_flow(client))
    wait_for_status(client, run["run_id"], "succeeded")
    deadline = time.monotonic() + 5
    while app.state.runs.is_live(run["run_id"]) and time.monotonic() < deadline:
        time.sleep(0.02)
    [snapshot] = read_stream(client, run["run_id"])
    assert snapshot["type"] == "snapshot"
    assert snapshot["run"]["status"] == "succeeded"
    assert snapshot["run"]["node_states"]["out"]["output"] == "Echo: hello from the trigger"


def test_cancel_stops_a_running_flow(client: TestClient) -> None:
    flow_id = create_flow(client)
    run = start(client, flow_id, input=" ".join(["word"] * 300))  # ~9 s of mock streaming
    wait_for_status(client, run["run_id"], "running")
    response = client.post(f"/runs/{run['run_id']}/cancel")
    assert response.status_code == 200
    record = response.json()
    assert record["status"] == "cancelled"
    assert record["node_states"]["a"]["status"] == "cancelled"
    assert "out" not in record["node_states"]  # never started
    # Cancelling again is harmless.
    assert client.post(f"/runs/{run['run_id']}/cancel").json()["status"] == "cancelled"


def test_invalid_flows_are_refused_with_their_issues(client: TestClient) -> None:
    broken = {
        **AGENT_FLOW,
        "nodes": [{**AGENT_FLOW["nodes"][1], "data": {"model": ""}}],
        "edges": [],
    }
    response = client.post(f"/flows/{create_flow(client, broken)}/runs", json={})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "flow_invalid"
    assert [i["id"] for i in detail["issues"]] == ["no-trigger", "required:a:model"]


def test_nodes_without_executors_are_refused(client: TestClient) -> None:
    flow = {
        "name": "Branch",
        "nodes": [node("t", "trigger_manual"), node("if", "logic_if", value="x")],
        "edges": [edge("t", "if")],
    }
    response = client.post(f"/flows/{create_flow(client, flow)}/runs", json={})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "nodes_not_runnable"
    assert [i["id"] for i in detail["issues"]] == ["not-runnable:if"]


def test_several_triggers_need_a_trigger_id(client: TestClient) -> None:
    flow = {
        "name": "Two",
        "nodes": [node("t1", "trigger_manual"), node("t2", "trigger_manual", input="two")],
        "edges": [],
    }
    flow_id = create_flow(client, flow)
    response = client.post(f"/flows/{flow_id}/runs", json={})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_trigger"
    run = start(client, flow_id, trigger_id="t2")
    read_stream(client, run["run_id"])
    record = wait_for_status(client, run["run_id"], "succeeded")
    assert list(record["node_states"]) == ["t2"]


def test_runs_are_private(client: TestClient, as_user: Callable[[str], None]) -> None:
    flow_id = create_flow(client)
    run = start(client, flow_id)
    as_user("mallory")
    assert client.post(f"/flows/{flow_id}/runs", json={}).status_code == 404
    for response in (
        client.get(f"/runs/{run['run_id']}"),
        client.get(f"/runs/{run['run_id']}/stream"),
        client.post(f"/runs/{run['run_id']}/cancel"),
    ):
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "run_not_found"
    as_user("alice")
    assert client.get(f"/runs/{run['run_id']}").status_code == 200


def test_unknown_runs_are_not_found(client: TestClient) -> None:
    assert client.get("/runs/nope").json()["detail"]["code"] == "run_not_found"
    assert client.get("/runs/bad%20id").status_code == 422


def test_too_many_active_runs(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runs_api, "get_settings", lambda: Settings(max_active_runs_per_user=1))
    flow_id = create_flow(client)
    run = start(client, flow_id, input=" ".join(["word"] * 300))
    response = client.post(f"/flows/{flow_id}/runs", json={})
    assert response.status_code == 429
    assert response.json()["detail"]["code"] == "too_many_runs"
    client.post(f"/runs/{run['run_id']}/cancel")
    assert client.post(f"/flows/{flow_id}/runs", json={}).status_code == 201


def test_runs_cut_off_by_a_restart_are_reported_as_interrupted(client: TestClient) -> None:
    flow_id = create_flow(client)
    repository = RunRepository(get_db())
    created = client.portal.call(  # type: ignore[union-attr]
        lambda: repository.create(
            owner_uid="alice", flow_id=flow_id, flow_version=1, trigger_id="t", input=None
        )
    )
    client.portal.call(  # type: ignore[union-attr]
        lambda: repository.update(created.run_id, {"status": "running"})
    )
    record = client.get(f"/runs/{created.run_id}").json()
    assert record["status"] == "failed"
    assert record["error"] == "The run was interrupted because the server restarted."
