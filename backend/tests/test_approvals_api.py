"""Approval Gates through the API (Firestore emulator): pause, answer, resume, list, cancel."""

from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient

from app.core.firebase import get_db
from app.repositories.runs import RunRepository
from tests.conftest import requires_firestore_emulator
from tests.flows import edge, node
from tests.test_runs_api import as_user, client, create_flow, read_stream, start, wait_for_status

__all__ = ["as_user", "client"]  # pytest fixtures, imported for use here

pytestmark = requires_firestore_emulator

FLOW = {
    "name": "Review before publishing",
    "nodes": [
        node("t", "trigger_manual", "trigger", input="first draft"),
        node("gate", "hitl_approval", "review", message="Publish “{{input}}”?"),
        node("yes", "output_display", "published"),
        node("no", "output_display", "discarded"),
    ],
    "edges": [edge("t", "gate"), edge("gate", "yes", "approved"), edge("gate", "no", "rejected")],
}


def paused_run(client: TestClient, flow: dict[str, Any] = FLOW) -> dict[str, Any]:
    run = start(client, create_flow(client, flow))
    stream = read_stream(client, run["run_id"])
    assert stream[-1]["type"] == "run_paused" and stream[-1]["pending"] == ["gate"]
    return wait_for_status(client, run["run_id"], "paused")


def answer(client: TestClient, run_id: str, node_id: str = "gate", **body: Any):
    return client.post(f"/runs/{run_id}/approvals/{node_id}", json=body)


def checkpoint_exists(client: TestClient, run_id: str) -> bool:
    repository = RunRepository(get_db())
    return client.portal.call(lambda: repository.load_checkpoint(run_id)) is not None  # type: ignore[union-attr]


def test_a_gate_pauses_the_run_and_waits_for_the_owner(client: TestClient) -> None:
    run = paused_run(client)
    assert run["status"] == "paused" and run["flow_name"] == "Review before publishing"
    assert run["node_states"]["gate"]["status"] == "waiting"
    [pending] = run["pending_approvals"]
    assert pending | {"requested_at": None} == {
        "node_id": "gate",
        "message": "Publish “first draft”?",
        "content": "first draft",
        "content_truncated": False,
        "allow_edit": True,
        "requested_at": None,
    }
    assert checkpoint_exists(client, run["run_id"])
    [item] = client.get("/approvals").json()
    assert item | {"requested_at": None} == {
        "run_id": run["run_id"],
        "flow_id": run["flow_id"],
        "flow_name": "Review before publishing",
        "node_id": "gate",
        "message": "Publish “first draft”?",
        "requested_at": None,
    }
    # A paused run isn't "interrupted" just because nothing executes it.
    assert client.get(f"/runs/{run['run_id']}").json()["status"] == "paused"
    [summary] = client.get(f"/flows/{run['flow_id']}/runs").json()
    assert summary["status"] == "paused"


def test_approving_with_edits_resumes_the_run(client: TestClient) -> None:
    run = paused_run(client)
    response = answer(client, run["run_id"], approved=True, content="final draft")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "running"

    stream = read_stream(client, run["run_id"])
    assert [e["type"] for e in stream][:2] == ["run_resumed", "approval_decided"]
    assert stream[1]["edited"] is True and stream[-1]["status"] == "succeeded"

    record = wait_for_status(client, run["run_id"], "succeeded")
    states = record["node_states"]
    assert states["yes"]["output"] == "final draft" and states["no"]["status"] == "skipped"
    assert states["gate"]["status"] == "succeeded" and states["gate"]["handles"] == ["approved"]
    assert record["pending_approvals"] == [] and client.get("/approvals").json() == []
    assert not checkpoint_exists(client, run["run_id"])


def test_rejecting_takes_the_rejected_branch(client: TestClient) -> None:
    run = paused_run(client)
    answer(client, run["run_id"], approved=False)
    read_stream(client, run["run_id"])
    record = wait_for_status(client, run["run_id"], "succeeded")
    assert record["node_states"]["no"]["output"] == "first draft"
    assert record["node_states"]["yes"]["status"] == "skipped"


def test_an_approval_can_only_be_answered_once(client: TestClient) -> None:
    run = paused_run(client)
    assert answer(client, run["run_id"], approved=True).status_code == 200
    second = answer(client, run["run_id"], approved=False)
    assert second.status_code == 409 and second.json()["detail"]["code"] == "run_not_paused"


def test_problems_answering(client: TestClient, as_user: Callable[[str], None]) -> None:
    locked = {
        **FLOW,
        "nodes": [
            *FLOW["nodes"][:1],
            node("gate", "hitl_approval", allow_edit=False),
            *FLOW["nodes"][2:],
        ],
    }
    run = paused_run(client, locked)
    response = answer(client, run["run_id"], approved=True, content="sneaky edit")
    assert response.status_code == 422 and response.json()["detail"]["code"] == "edit_not_allowed"
    response = answer(client, run["run_id"], "no", approved=True)
    assert response.status_code == 404 and response.json()["detail"]["code"] == "approval_not_found"
    as_user("mallory")
    assert answer(client, run["run_id"], approved=True).status_code == 404
    assert client.get("/approvals").json() == []
    as_user("alice")
    # Nothing was changed by the refused attempts.
    assert client.get(f"/runs/{run['run_id']}").json()["status"] == "paused"


def test_stopping_a_paused_run(client: TestClient) -> None:
    run = paused_run(client)
    response = client.post(f"/runs/{run['run_id']}/cancel")
    assert response.status_code == 200
    record = response.json()
    assert record["status"] == "cancelled" and record["pending_approvals"] == []
    assert client.get("/approvals").json() == []
    assert not checkpoint_exists(client, run["run_id"])
    assert answer(client, run["run_id"], approved=True).status_code == 409


def test_deleting_the_flow_removes_paused_runs_and_their_state(client: TestClient) -> None:
    run = paused_run(client)
    assert client.delete(f"/flows/{run['flow_id']}").status_code == 204
    assert client.get(f"/runs/{run['run_id']}").status_code == 404
    assert not checkpoint_exists(client, run["run_id"])
