"""The HTTP Response node: what it sends (app/services/webhooks.py `build_response`), the executor,
and webhook callers getting the flow's answer (app/api/webhooks.py, Firestore emulator)."""

import asyncio
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api import webhooks as webhooks_api
from app.core.config import Settings
from app.engine.compiler import compile_flow
from app.engine.runner import Runner
from app.services.webhooks import ResponseError, build_response
from tests.conftest import requires_firestore_emulator
from tests.flows import edge, flow, node

TEXT = "text/plain; charset=utf-8"


@pytest.fixture
def client(kb_client: TestClient) -> TestClient:
    return kb_client  # signed in as alice, Firestore emptied


# ── What gets sent ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("content_type", "body", "text", "sent_type"),
    [
        ("auto", {"a": [1, "é"]}, '{"a": [1, "é"]}', "application/json"),
        ("auto", [1, 2], "[1, 2]", "application/json"),
        ("auto", 3.5, "3.5", "application/json"),
        ("auto", "Hello", "Hello", TEXT),
        ("auto", None, "", TEXT),
        ("application/json", '{"ok": true}', '{"ok": true}', "application/json"),
        ("application/json", None, "null", "application/json"),
        ("text/plain", {"a": 1}, '{\n  "a": 1\n}', TEXT),
        ("text/html", "<p>Hi</p>", "<p>Hi</p>", "text/html; charset=utf-8"),
    ],
)
def test_bodies(content_type: str, body: Any, text: str, sent_type: str) -> None:
    assert build_response(200, content_type, {}, body) == {
        "status_code": 200,
        "headers": {"Content-Type": sent_type},
        "body": text,
    }


def test_no_content_has_no_body() -> None:
    assert build_response(204, "auto", {}, {"ignored": True}) == {
        "status_code": 204,
        "headers": {},
        "body": "",
    }


def test_extra_headers() -> None:
    sent = build_response(
        302, "auto", {"Location": "https://example.com", "X-Cached": False, "X-Count": 2}, ""
    )
    assert sent["headers"] == {
        "Content-Type": TEXT,
        "Location": "https://example.com",
        "X-Cached": "false",
        "X-Count": "2",
    }
    xml = build_response(200, "auto", {"content-type": "application/xml"}, "<a/>")
    assert xml["headers"] == {"content-type": "application/xml"}  # an explicit type wins


@pytest.mark.parametrize(
    ("status", "content_type", "headers", "body", "message"),
    [
        (199, "auto", {}, "", "The status code must be between 200 and 599."),
        (True, "auto", {}, "", "The status code must be a whole number."),
        (200, "application/json", {}, "{oops", "The body isn't valid JSON (Expecting property"),
        (200, "image/png", {}, "", "Unsupported content type “image/png”."),
        (200, "auto", [], "", "Extra headers must be a JSON object."),
        (200, "auto", {"Bad Name": "x"}, "", "“Bad Name” isn't a valid header name."),
        (200, "auto", {"Content-Length": "9"}, "", "The server sets Content-Length itself."),
        (200, "auto", {"X-A": {"b": 1}}, "", "The X-A header needs a text value."),
        (200, "auto", {"X-A": "a\r\nSet-Cookie: x"}, "", "The X-A header can't contain line"),
    ],
)
def test_problems(status: Any, content_type: str, headers: Any, body: str, message: str) -> None:
    with pytest.raises(ResponseError) as refused:
        build_response(status, content_type, headers, body)
    assert str(refused.value).startswith(message)


# ── The executor ──────────────────────────────────────────────────────────

REQUEST = {"method": "POST", "query": {}, "headers": {}, "body": {"name": "Ada"}}


def run_response(**data: Any) -> tuple[Any, list[dict]]:
    events: list[dict] = []
    plan = compile_flow(
        flow(
            [node("w", "trigger_webhook", "webhook"), node("r", "action_http_response", **data)],
            [edge("w", "r")],
        )
    )
    outcome = asyncio.run(Runner(plan, run_id="r", input=REQUEST, sink=events.append).run())
    finished = next(e for e in events if e["type"] == "node_finished" and e["node_id"] == "r")
    return outcome.status, finished


def test_the_node_outputs_the_response() -> None:
    status, finished = run_response(body="{{webhook.output.body}}", status_code=201)
    assert status == "succeeded"
    assert finished["output"] == {
        "status_code": 201,
        "headers": {"Content-Type": "application/json"},
        "body": '{"name": "Ada"}',
    }


def test_problems_fail_the_node() -> None:
    status, finished = run_response(
        body="Hi {{webhook.output.body.name}}", content_type="application/json"
    )
    assert status == "failed"
    assert finished["error"].startswith("The body isn't valid JSON")


# ── Webhook callers get the answer (Firestore emulator) ──────────────────


def create_flow(client: TestClient, nodes: list[dict], edges: list[dict]) -> str:
    response = client.post("/flows", json={"name": "Answers", "nodes": nodes, "edges": edges})
    assert response.status_code == 201, response.text
    return response.json()["flow_id"]


def wait_for(client: TestClient, run_id: str, *statuses: str) -> dict[str, Any]:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        run = client.get(f"/runs/{run_id}").json()
        if run["status"] in statuses:
            return run
        time.sleep(0.05)
    raise AssertionError(f"run never reached {statuses}: {run}")


HOOK = node("hook", "trigger_webhook", "webhook")
GREETER = node("a", "agent_node", model="mock/echo", prompt="Hello {{webhook.output.body.name}}")


@requires_firestore_emulator
class TestCallers:
    def test_the_caller_gets_the_flows_answer(self, client: TestClient) -> None:
        flow_id = create_flow(
            client,
            [
                HOOK,
                GREETER,
                node("r", "action_http_response", status_code=201, headers={"X-Flow": "mesh"}),
                node("after", "output_display", "after"),
            ],
            [edge("hook", "a"), edge("a", "r"), edge("r", "after")],
        )
        response = client.post(f"/hooks/{flow_id}/hook", json={"name": "Ada"})
        assert response.status_code == 201, response.text
        assert response.text == "Hello Ada"
        assert response.headers["content-type"] == TEXT
        assert response.headers["x-flow"] == "mesh"

        # The run carries on after answering; its record shows what was sent.
        [run] = client.get(f"/flows/{flow_id}/runs").json()
        done = wait_for(client, run["run_id"], "succeeded")
        assert done["node_states"]["r"]["output"]["body"] == "Hello Ada"
        assert done["node_states"]["after"]["status"] == "succeeded"

    def test_objects_are_sent_as_json(self, client: TestClient) -> None:
        flow_id = create_flow(
            client,
            [HOOK, node("r", "action_http_response", body="{{webhook.output.body}}")],
            [edge("hook", "r")],
        )
        response = client.post(f"/hooks/{flow_id}/hook", json={"name": "Ada", "n": [1, 2]})
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/json"
        assert response.json() == {"name": "Ada", "n": [1, 2]}

    def test_a_branch_that_never_answers(self, client: TestClient) -> None:
        flow_id = create_flow(
            client,
            [
                HOOK,
                node(
                    "if",
                    "logic_if",
                    field="{{webhook.output.body.name}}",
                    operator="contains",
                    value="Bob",
                ),
                node("r", "action_http_response"),
            ],
            [edge("hook", "if"), edge("if", "r", "true")],
        )
        response = client.post(f"/hooks/{flow_id}/hook", json={"name": "Ada"})
        assert response.status_code == 200
        assert response.json() == {"run_id": response.json()["run_id"], "status": "succeeded"}

    def test_a_flow_that_fails_before_answering(self, client: TestClient) -> None:
        flow_id = create_flow(
            client,
            [
                HOOK,
                node("r", "action_http_response", body="not json", content_type="application/json"),
            ],
            [edge("hook", "r")],
        )
        response = client.post(f"/hooks/{flow_id}/hook", json={})
        assert response.status_code == 500
        assert response.json()["status"] == "failed"
        run = client.get(f"/runs/{response.json()['run_id']}").json()
        assert run["node_states"]["r"]["error"].startswith("The body isn't valid JSON")

    def test_a_flow_waiting_for_approval(self, client: TestClient) -> None:
        flow_id = create_flow(
            client,
            [HOOK, node("gate", "hitl_approval"), node("r", "action_http_response")],
            [edge("hook", "gate"), edge("gate", "r", "approved")],
        )
        response = client.post(f"/hooks/{flow_id}/hook", json={})
        assert response.status_code == 202
        assert response.json()["status"] == "paused"

    def test_a_slow_flow_answers_with_its_run_id(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        impatient = Settings(webhook_response_timeout_seconds=0.3)
        monkeypatch.setattr(webhooks_api, "get_settings", lambda: impatient)
        slow = node("a", "agent_node", model="mock/echo", prompt=" ".join(["word"] * 50))
        flow_id = create_flow(
            client,
            [HOOK, slow, node("r", "action_http_response")],
            [edge("hook", "a"), edge("a", "r")],
        )
        response = client.post(f"/hooks/{flow_id}/hook", json={})
        assert response.status_code == 202
        assert response.json()["status"] == "running"
        wait_for(client, response.json()["run_id"], "succeeded")  # it finishes regardless
