"""Webhook triggers: request → trigger output (app/services/webhooks.py), the executor, and
`/hooks/{flow_id}/{node_id}` against the Firestore emulator."""

import asyncio
import json
import time
import urllib.request
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api import webhooks as webhooks_api
from app.core.auth import AuthUser, get_current_user
from app.core.config import Settings
from app.core.firebase import get_db
from app.engine.compiler import compile_flow
from app.engine.runner import Runner
from app.main import app
from app.services import launch
from app.services.webhooks import (
    InvalidBodyError,
    RateLimiter,
    UnsupportedBodyError,
    collect_fields,
    parse_body,
    stand_in_body,
    visible_headers,
)
from tests.conftest import FIRESTORE_EMULATOR, requires_firestore_emulator
from tests.flows import edge, flow, node

# ── Request → trigger output ──────────────────────────────────────────────


@pytest.mark.parametrize(
    ("content_type", "raw", "body"),
    [
        ("application/json", b'{"name": "Ada", "tags": [1, 2]}', {"name": "Ada", "tags": [1, 2]}),
        ("application/vnd.api+json; charset=utf-8", b"[1]", [1]),
        ("application/json", b"\xef\xbb\xbf{}", {}),  # BOM
        ("application/x-www-form-urlencoded", b"a=1&b=&a=2", {"a": ["1", "2"], "b": ""}),
        ("text/plain", "héllo".encode(), "héllo"),
        ("", b"plain words", "plain words"),
        ("application/json", b"", None),
    ],
)
def test_bodies(content_type: str, raw: bytes, body: Any) -> None:
    assert parse_body(content_type, raw) == body


def test_bad_bodies_are_refused() -> None:
    with pytest.raises(InvalidBodyError) as refused:
        parse_body("application/json", b"{oops")
    assert refused.value.message == (
        "The body isn't valid JSON: Expecting property name enclosed in double quotes "
        "(line 1, column 2)."
    )
    for raw in (b"\xff\xfe\x00binary", b"nul\x00byte"):
        with pytest.raises(UnsupportedBodyError):
            parse_body("application/octet-stream", raw)


def test_fields_headers_and_test_bodies() -> None:
    assert collect_fields([("a", "1"), ("b", "2"), ("a", "3"), ("a", "4")]) == {
        "a": ["1", "3", "4"],
        "b": "2",
    }
    headers = [
        ("Content-Type", "application/json"),
        ("X-Tag", "one"),
        ("x-tag", "two"),
        ("Authorization", "Bearer t"),
        ("Cookie", "c=1"),
        ("Proxy-Authorization", "p"),
        ("X-Mesh-Secret", "s3cret"),
    ]
    assert visible_headers(headers) == {"content-type": "application/json", "x-tag": "one, two"}
    assert stand_in_body('{"a": 1}') == {"a": 1}
    assert stand_in_body("not json") == "not json"
    assert stand_in_body("  ") is None


def test_rate_limiter() -> None:
    now = [0.0]
    limiter = RateLimiter(2, window=60, clock=lambda: now[0])
    assert limiter.hit("a") is None
    assert limiter.hit("b") is None  # keys are separate
    now[0] = 10
    assert limiter.hit("a") is None
    assert limiter.hit("a") == 50  # the first hit expires at 60
    now[0] = 60
    assert limiter.hit("a") is None
    assert limiter.hit("a") == 10


# ── The executor ──────────────────────────────────────────────────────────


def run_trigger(data: dict[str, Any], input: Any) -> tuple[Any, list[dict]]:
    events: list[dict] = []
    plan = compile_flow(flow([node("w", "trigger_webhook", "webhook", **data)], []))
    outcome = asyncio.run(Runner(plan, run_id="r", input=input, sink=events.append).run())
    assert outcome.status == "succeeded"
    finished = next(e for e in events if e["type"] == "node_finished")
    return finished["output"], [e["message"] for e in events if e["type"] == "log"]


def test_outputs_the_request_that_started_the_run() -> None:
    request = {"method": "PUT", "query": {}, "headers": {}, "body": {"a": 1}}
    output, logs = run_trigger({"test_body": "ignored"}, request)
    assert output == request
    assert logs == []


@pytest.mark.parametrize(
    ("input", "body", "source"),
    [
        (None, {"name": "Ada"}, "the Test body"),
        ("typed text", "typed text", "the run's input"),
    ],
)
def test_runs_without_a_request_use_a_stand_in(input: Any, body: Any, source: str) -> None:
    output, logs = run_trigger({"method": "GET", "test_body": '{"name": "Ada"}'}, input)
    assert output == {"method": "GET", "query": {}, "headers": {}, "body": body}
    assert logs == [f"Started without a request: {source} stands in for the request body"]


# ── The endpoint (Firestore emulator) ────────────────────────────────────

CLEAR_URL = f"{FIRESTORE_EMULATOR}/emulator/v1/projects/demo-mesh/databases/(default)/documents"

HOOK_FLOW = {
    "name": "Greeter",
    "nodes": [
        node("hook", "trigger_webhook", "webhook", secret="s3cret", test_body='{"name": "Test"}'),
        node("a", "agent_node", model="mock/echo", prompt="Hello {{webhook.output.body.name}}"),
        node("out", "output_display", "result"),
        node("t", "trigger_manual", "trigger"),
    ],
    "edges": [edge("hook", "a"), edge("a", "out"), edge("t", "out")],
}
SECRET = {"X-Mesh-Secret": "s3cret"}


@pytest.fixture
def client() -> Iterator[TestClient]:
    urllib.request.urlopen(urllib.request.Request(CLEAR_URL, method="DELETE"), timeout=5)
    get_db.cache_clear()
    with TestClient(app) as test_client:
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="alice")
        yield test_client
    app.dependency_overrides.clear()
    get_db.cache_clear()


def create_flow(client: TestClient, flow: dict[str, Any] = HOOK_FLOW) -> str:
    response = client.post("/flows", json=flow)
    assert response.status_code == 201, response.text
    return response.json()["flow_id"]


def finished(client: TestClient, run_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        run = client.get(f"/runs/{run_id}").json()
        if run["status"] in ("succeeded", "failed", "cancelled"):
            return run
        time.sleep(0.05)
    raise AssertionError(f"run still going: {run}")


def error(response: Any, status: int) -> str:
    assert response.status_code == status, response.text
    return response.json()["detail"]["code"]


@requires_firestore_emulator
class TestEndpoint:
    def test_a_request_runs_the_flow_from_its_trigger(self, client: TestClient) -> None:
        flow_id = create_flow(client)
        response = client.post(
            f"/hooks/{flow_id}/hook?a=1&tag=x&tag=y",
            json={"name": "Ada"},
            headers={**SECRET, "Authorization": "Bearer nope", "X-Source": "tests"},
        )
        assert response.status_code == 202, response.text
        accepted = response.json()
        assert accepted["status"] == "queued"

        run = finished(client, accepted["run_id"])
        assert run["status"] == "succeeded", run
        assert run["trigger_id"] == "hook"
        request = run["node_states"]["hook"]["output"]
        assert request["method"] == "POST"
        assert request["query"] == {"a": "1", "tag": ["x", "y"]}
        assert request["body"] == {"name": "Ada"}
        assert request["headers"]["x-source"] == "tests"
        assert "authorization" not in request["headers"]
        assert "x-mesh-secret" not in request["headers"]
        assert run["node_states"]["out"]["output"] == "Hello Ada"
        assert json.loads(run["input"])["body"] == {"name": "Ada"}  # recorded as JSON text
        assert "t" not in run["node_states"]  # the other trigger's branch isn't part of it

        history = client.get(f"/flows/{flow_id}/runs").json()
        assert [r["run_id"] for r in history] == [accepted["run_id"]]

    def test_the_run_belongs_to_the_flows_owner(self, client: TestClient) -> None:
        flow_id = create_flow(client)
        run_id = client.post(f"/hooks/{flow_id}/hook", json={}, headers=SECRET).json()["run_id"]
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="bob")
        assert error(client.get(f"/runs/{run_id}"), 404) == "run_not_found"
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="alice")
        assert finished(client, run_id)["status"] == "succeeded"

    def test_form_and_text_bodies_and_get_requests(self, client: TestClient) -> None:
        hooks = [
            node("form", "trigger_webhook", "form"),
            node("text", "trigger_webhook", "text", method="PUT"),
            node("get", "trigger_webhook", "get", method="GET"),
        ]
        flow_id = create_flow(client, {"name": "Hooks", "nodes": hooks, "edges": []})
        sent = [
            client.post(f"/hooks/{flow_id}/form", data={"name": "Ada", "tag": ["a", "b"]}),
            client.put(f"/hooks/{flow_id}/text", content="just text"),
            client.get(f"/hooks/{flow_id}/get?q=1"),
        ]
        outputs = [
            finished(client, r.json()["run_id"])["node_states"][hook["id"]]["output"]
            for r, hook in zip(sent, hooks, strict=True)
        ]
        assert outputs[0]["body"] == {"name": "Ada", "tag": ["a", "b"]}
        assert (outputs[1]["method"], outputs[1]["body"]) == ("PUT", "just text")
        assert (outputs[2]["method"], outputs[2]["query"], outputs[2]["body"]) == (
            "GET",
            {"q": "1"},
            None,
        )

    def test_unknown_webhooks_are_not_found(self, client: TestClient) -> None:
        flow_id = create_flow(client)
        for path in (f"/hooks/{flow_id}/nope", f"/hooks/{flow_id}/t", "/hooks/missing/hook"):
            assert error(client.post(path, json={}, headers=SECRET), 404) == "webhook_not_found"

    def test_the_secret_is_required(self, client: TestClient) -> None:
        flow_id = create_flow(client)
        url = f"/hooks/{flow_id}/hook"
        assert error(client.post(url, json={}), 401) == "invalid_webhook_secret"
        wrong = {"X-Mesh-Secret": "guess"}
        assert error(client.post(url, json={}, headers=wrong), 401) == "invalid_webhook_secret"
        assert client.post(url, json={}, headers=SECRET).status_code == 202

    def test_other_methods_are_refused(self, client: TestClient) -> None:
        flow_id = create_flow(client)
        response = client.get(f"/hooks/{flow_id}/hook", headers=SECRET)
        assert error(response, 405) == "method_not_allowed"
        assert response.headers["allow"] == "POST"
        assert client.delete(f"/hooks/{flow_id}/hook").status_code == 405  # never a webhook's

    def test_bad_bodies_are_refused(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        flow_id = create_flow(client)
        url = f"/hooks/{flow_id}/hook"
        json_type = {**SECRET, "Content-Type": "application/json"}
        assert error(client.post(url, content=b"{oops", headers=json_type), 400) == "invalid_body"
        binary = {**SECRET, "Content-Type": "application/octet-stream"}
        assert error(client.post(url, content=b"\xff\xfe", headers=binary), 415) == (
            "unsupported_body"
        )
        small = Settings(webhook_max_body_bytes=10)
        monkeypatch.setattr(webhooks_api, "get_settings", lambda: small)
        response = client.post(url, content=b"x" * 11, headers=SECRET)
        assert error(response, 413) == "webhook_body_too_large"
        assert "at most 10 bytes" in response.json()["detail"]["message"]

    def test_requests_per_webhook_are_rate_limited(self, client: TestClient) -> None:
        flow_id = create_flow(client)
        client.app.state.webhook_limiter = RateLimiter(2)
        url = f"/hooks/{flow_id}/hook"
        for _ in range(2):
            assert client.post(url, json={}, headers=SECRET).status_code == 202
        response = client.post(url, json={}, headers=SECRET)
        assert error(response, 429) == "rate_limited"
        assert 1 <= int(response.headers["retry-after"]) <= 60

    def test_the_owners_run_limit_applies(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(launch, "get_settings", lambda: Settings(max_active_runs_per_user=1))
        flow_id = create_flow(client)
        long = {"name": " ".join(["word"] * 300)}
        first = client.post(f"/hooks/{flow_id}/hook", json=long, headers=SECRET)
        assert first.status_code == 202
        response = client.post(f"/hooks/{flow_id}/hook", json={}, headers=SECRET)
        assert error(response, 429) == "too_many_runs"
        client.post(f"/runs/{first.json()['run_id']}/cancel")

    def test_flows_with_problems_dont_reveal_them(self, client: TestClient) -> None:
        broken = {
            "name": "Broken",
            "nodes": [node("hook", "trigger_webhook"), node("a", "agent_node", model="")],
            "edges": [edge("hook", "a")],
        }
        response = client.post(f"/hooks/{create_flow(client, broken)}/hook", json={})
        assert error(response, 422) == "flow_not_runnable"
        assert set(response.json()["detail"]) == {"code", "message"}

    def test_the_editor_runs_it_with_the_test_body(self, client: TestClient) -> None:
        flow_id = create_flow(client)
        run_id = client.post(f"/flows/{flow_id}/runs", json={"trigger_id": "hook"}).json()["run_id"]
        run = finished(client, run_id)
        assert run["node_states"]["hook"]["output"]["body"] == {"name": "Test"}
        assert run["node_states"]["out"]["output"] == "Hello Test"
