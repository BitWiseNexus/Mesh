"""Send Email (app/nodes/executors/action_email.py), with Resend replaced by a mock transport."""

import asyncio
import json
from typing import Any

import httpx
import pytest

from app.core.config import Settings
from app.engine.compiler import compile_flow
from app.engine.runner import Runner
from app.nodes.executors import action_email
from app.nodes.executors.action_email import recipients, valid_address
from tests.flows import edge, flow, node


@pytest.mark.parametrize(
    ("text", "valid"),
    [
        ("ada@example.com", True),
        ("Ada Lovelace <ada@example.com>", True),
        ("a.b+tag@mail.example.co.uk", True),
        ("ada@example", False),
        ("ada example.com", False),
        ("<>", False),
        ("Ada <ada@example.com", False),
    ],
)
def test_addresses(text: str, valid: bool) -> None:
    assert valid_address(text) is valid


def test_recipients() -> None:
    assert recipients(" a@x.io, B <b@y.io>;c@z.io\n") == ["a@x.io", "B <b@y.io>", "c@z.io"]


class FakeSecrets:
    def __init__(self, key: str | None = "re_saved") -> None:
        self.key = key
        self.asked: list[tuple[str, str | None]] = []

    async def get(self, provider: str, credential_id: str | None = None) -> str | None:
        self.asked.append((provider, credential_id))
        return self.key


class FakeResend:
    """Records requests; answers with `status` and `reply`."""

    def __init__(self, status: int = 200, reply: Any = None) -> None:
        self.requests: list[httpx.Request] = []
        self.status = status
        self.reply = {"id": "email-1"} if reply is None else reply

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, json=self.reply)

    @property
    def sent(self) -> dict[str, Any]:
        return json.loads(self.requests[-1].content)


@pytest.fixture
def resend(monkeypatch: pytest.MonkeyPatch) -> FakeResend:
    fake = FakeResend()
    monkeypatch.setattr(action_email, "TRANSPORT", httpx.MockTransport(fake))
    monkeypatch.setattr(action_email, "get_settings", lambda: Settings(resend_api_key=None))
    return fake


EMAIL = {"to": "ada@example.com", "subject": "Report for {{input}}"}


def run(data: dict[str, Any], secrets: FakeSecrets | None = None) -> tuple[str, dict, list[str]]:
    events: list[dict] = []
    plan = compile_flow(
        flow(
            [node("t", "trigger_manual"), node("e", "action_email", **{**EMAIL, **data})],
            [edge("t", "e")],
        )
    )
    runner = Runner(
        plan,
        run_id="r",
        input="Monday",
        sink=events.append,
        secrets=secrets if secrets is not None else FakeSecrets(),
    )
    outcome = asyncio.run(runner.run())
    finished = next(e for e in events if e["type"] == "node_finished" and e["node_id"] == "e")
    logs = [e["message"] for e in events if e["type"] == "log"]
    return outcome.status, finished, logs


def test_sends_the_email(resend: FakeResend) -> None:
    status, finished, logs = run({})
    assert status == "succeeded"
    [request] = resend.requests
    assert str(request.url) == "https://api.resend.com/emails"
    assert request.headers["authorization"] == "Bearer re_saved"
    assert resend.sent == {
        "from": "Mesh <onboarding@resend.dev>",
        "to": ["ada@example.com"],
        "subject": "Report for Monday",
        "text": "Monday",
    }
    assert finished["output"] == {
        "id": "email-1",
        "sent": True,
        "from": "Mesh <onboarding@resend.dev>",
        "to": ["ada@example.com"],
        "subject": "Report for Monday",
        "body": "Monday",
    }
    assert logs == ["Sent “Report for Monday” to ada@example.com"]


def test_html_a_sender_and_a_chosen_key(resend: FakeResend) -> None:
    secrets = FakeSecrets()
    run(
        {
            "format": "html",
            "body": "<p>{{input}}</p>",
            "from_address": "Reports <reports@acme.io>",
            "credential_id": "cred-7",
            "subject": "Line\nbreaks   go",
        },
        secrets,
    )
    assert secrets.asked == [("resend", "cred-7")]
    assert resend.sent["html"] == "<p>Monday</p>" and "text" not in resend.sent
    assert resend.sent["from"] == "Reports <reports@acme.io>"
    assert resend.sent["subject"] == "Line breaks go"


def test_the_servers_key_is_the_fallback(
    resend: FakeResend, monkeypatch: pytest.MonkeyPatch
) -> None:
    server = Settings(resend_api_key="re_server")
    monkeypatch.setattr(action_email, "get_settings", lambda: server)
    run({}, FakeSecrets(key=None))
    assert resend.requests[0].headers["authorization"] == "Bearer re_server"


def test_test_mode_sends_nothing(resend: FakeResend) -> None:
    status, finished, logs = run({"test_mode": True}, FakeSecrets(key=None))
    assert status == "succeeded"
    assert resend.requests == []
    assert finished["output"]["sent"] is False and finished["output"]["id"] is None
    assert logs == ["Test mode: “Report for Monday” to ada@example.com wasn't sent"]


@pytest.mark.parametrize(
    ("data", "key", "message"),
    [
        ({}, None, "No Resend API key: add one under API keys"),
        ({"to": "nobody"}, "k", "Not an email address: “nobody”"),
        ({"to": "{{input.missing}}"}, "k", "No recipient: “To” is empty"),
        ({"to": ", ".join(f"p{i}@x.io" for i in range(51))}, "k", "Too many recipients (51)"),
        ({"subject": "{{input.missing}}"}, "k", "No subject"),
        ({"from_address": "Mesh"}, "k", "“From” isn't an email address: “Mesh”"),
    ],
)
def test_problems_fail_the_node(
    resend: FakeResend, data: dict, key: str | None, message: str
) -> None:
    status, finished, _ = run(data, FakeSecrets(key=key))
    assert status == "failed"
    assert finished["error"].startswith(message)
    assert resend.requests == []


@pytest.mark.parametrize(
    ("status", "reply", "message"),
    [
        (
            401,
            {"name": "missing_api_key", "message": "Missing API key"},
            "Resend rejected the API key",
        ),
        (
            400,
            {"name": "invalid_api_key", "message": "API key is invalid"},
            "Resend rejected the API key",
        ),
        (
            403,
            {
                "name": "validation_error",
                "message": "You can only send testing emails to your own email address",
            },
            "Resend didn't send the email: You can only send testing emails to your own email "
            "address",
        ),
        (429, {"name": "rate_limit_exceeded"}, "Resend is rate-limiting emails"),
        (500, [], "Resend didn't send the email: error 500"),
    ],
)
def test_resend_errors(resend: FakeResend, status: int, reply: Any, message: str) -> None:
    resend.status, resend.reply = status, reply
    outcome, finished, _ = run({})
    assert outcome == "failed"
    assert finished["error"].startswith(message)


def test_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(action_email, "TRANSPORT", httpx.MockTransport(refuse))
    status, finished, _ = run({})
    assert status == "failed"
    assert finished["error"] == "Couldn't reach Resend: connection refused"
