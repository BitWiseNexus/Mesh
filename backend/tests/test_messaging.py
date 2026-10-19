"""Slack Message and Telegram Message (app/nodes/executors/action_slack.py, action_telegram.py),
with Slack's and Telegram's APIs replaced by mock transports."""

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from app.core.config import Settings
from app.engine.compiler import compile_flow
from app.engine.runner import Runner
from app.nodes.executors import action_slack, action_telegram
from tests.flows import edge, flow, node

TOKEN = "123456789:AAH" + "x" * 30


class FakeSecrets:
    def __init__(self, key: str | None) -> None:
        self.key = key
        self.asked: list[tuple[str, str | None]] = []

    async def get(self, provider: str, credential_id: str | None = None) -> str | None:
        self.asked.append((provider, credential_id))
        return self.key


class FakeApi:
    """Records requests; `answer(request, n)` gives the n-th reply (default: `reply` with 200)."""

    def __init__(self, reply: Any, status: int = 200) -> None:
        self.requests: list[httpx.Request] = []
        self.reply, self.status = reply, status
        self.answer: Callable[[httpx.Request, int], httpx.Response] | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.answer:
            return self.answer(request, len(self.requests))
        return httpx.Response(self.status, json=self.reply)

    def sent(self, n: int = -1) -> dict[str, Any]:
        return json.loads(self.requests[n].content)


def run(
    type: str, data: dict[str, Any], key: str | None = "saved"
) -> tuple[str, dict, list[tuple[str, str]], FakeSecrets]:
    events: list[dict] = []
    plan = compile_flow(
        flow([node("t", "trigger_manual"), node("m", type, **data)], [edge("t", "m")])
    )
    secrets = FakeSecrets(key)
    runner = Runner(plan, run_id="r", input="Hello team", sink=events.append, secrets=secrets)
    outcome = asyncio.run(runner.run())
    finished = next(e for e in events if e["type"] == "node_finished" and e["node_id"] == "m")
    logs = [(e["level"], e["message"]) for e in events if e["type"] == "log"]
    return outcome.status, finished, logs, secrets


def no_server_keys() -> Settings:
    return Settings(slack_bot_token=None, telegram_bot_token=None)


# ── Slack ─────────────────────────────────────────────────────────────────


@pytest.fixture
def slack(monkeypatch: pytest.MonkeyPatch) -> FakeApi:
    fake = FakeApi({"ok": True, "channel": "C0123", "ts": "1760000000.000100"})
    monkeypatch.setattr(action_slack, "TRANSPORT", httpx.MockTransport(fake))
    monkeypatch.setattr(action_slack, "get_settings", no_server_keys)
    return fake


def run_slack(data: dict[str, Any], key: str | None = "xoxb-saved") -> tuple:
    return run("action_slack", {"channel": "#general", **data}, key)


def test_slack_posts(slack: FakeApi) -> None:
    status, finished, logs, secrets = run_slack({"credential_id": "cred-1"})
    assert status == "succeeded"
    [request] = slack.requests
    assert str(request.url) == "https://slack.com/api/chat.postMessage"
    assert request.headers["authorization"] == "Bearer xoxb-saved"
    assert slack.sent() == {"channel": "#general", "text": "Hello team"}
    assert secrets.asked == [("slack", "cred-1")]
    assert finished["output"] == {
        "sent": True,
        "channel": "C0123",
        "ts": "1760000000.000100",
        "text": "Hello team",
    }
    assert logs == [("info", "Posted to #general")]


def test_slack_uses_the_servers_token(slack: FakeApi, monkeypatch: pytest.MonkeyPatch) -> None:
    server = Settings(slack_bot_token="xoxb-server")
    monkeypatch.setattr(action_slack, "get_settings", lambda: server)
    run_slack({}, key=None)
    assert slack.requests[0].headers["authorization"] == "Bearer xoxb-server"


def test_slack_test_mode(slack: FakeApi) -> None:
    status, finished, logs, _ = run_slack({"test_mode": True}, key=None)
    assert status == "succeeded" and slack.requests == []
    assert finished["output"]["sent"] is False and finished["output"]["ts"] is None
    assert logs == [("info", "Test mode: the message to #general wasn't posted")]


def test_slack_warns_about_long_messages(slack: FakeApi) -> None:
    _, _, logs, _ = run_slack({"text": "x" * 40_001})
    assert logs[0] == ("warning", "Slack shows at most 40,000 characters: the rest is cut off")


@pytest.mark.parametrize(
    ("reply", "status", "message"),
    [
        ({"ok": False, "error": "invalid_auth"}, 200, "Slack rejected the bot token"),
        ({"ok": False, "error": "token_revoked"}, 200, "Slack rejected the bot token (it was"),
        ({"ok": False, "error": "missing_scope"}, 200, "The bot token lacks the chat:write"),
        (
            {"ok": False, "error": "channel_not_found"},
            200,
            "Slack can't find the channel “#general”",
        ),
        ({"ok": False, "error": "not_in_channel"}, 200, "The bot isn't in “#general”"),
        ({"ok": False, "error": "weird"}, 200, "Slack didn't post the message: weird"),
        ({"ok": False, "error": "ratelimited"}, 429, "Slack is rate-limiting messages"),
        ([], 502, "Slack answered unexpectedly (HTTP 502)"),
    ],
)
def test_slack_errors(slack: FakeApi, reply: Any, status: int, message: str) -> None:
    slack.reply, slack.status = reply, status
    outcome, finished, _, _ = run_slack({})
    assert outcome == "failed"
    assert finished["error"].startswith(message)


@pytest.mark.parametrize(
    ("data", "key", "message"),
    [
        ({}, None, "No Slack bot token: add one under API keys"),
        ({"channel": "{{input.missing}}"}, "k", "No channel"),
        ({"text": "{{input.missing}}"}, "k", "Nothing to send"),
    ],
)
def test_slack_problems(slack: FakeApi, data: dict, key: str | None, message: str) -> None:
    status, finished, _, _ = run_slack(data, key)
    assert status == "failed" and finished["error"].startswith(message)
    assert slack.requests == []


# ── Telegram ──────────────────────────────────────────────────────────────


@pytest.fixture
def telegram(monkeypatch: pytest.MonkeyPatch) -> FakeApi:
    fake = FakeApi({"ok": True, "result": {"message_id": 41}})
    monkeypatch.setattr(action_telegram, "TRANSPORT", httpx.MockTransport(fake))
    monkeypatch.setattr(action_telegram, "get_settings", no_server_keys)
    return fake


def run_telegram(data: dict[str, Any], key: str | None = TOKEN) -> tuple:
    return run("action_telegram", {"chat_id": "123456789", **data}, key)


def test_telegram_sends(telegram: FakeApi) -> None:
    status, finished, logs, secrets = run_telegram({})
    assert status == "succeeded"
    [request] = telegram.requests
    assert str(request.url) == f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    assert telegram.sent() == {"chat_id": "123456789", "text": "Hello team"}
    assert secrets.asked == [("telegram", None)]
    assert finished["output"] == {
        "sent": True,
        "chat_id": "123456789",
        "message_id": 41,
        "message_ids": [41],
        "text": "Hello team",
    }
    assert logs == [("info", "Sent to 123456789")]


def test_telegram_html_and_channels(telegram: FakeApi) -> None:
    run_telegram({"chat_id": "@mesh_news", "format": "html", "text": "<b>{{input}}</b>"})
    assert telegram.sent() == {
        "chat_id": "@mesh_news",
        "text": "<b>Hello team</b>",
        "parse_mode": "HTML",
    }


def test_long_plain_text_is_split(telegram: FakeApi) -> None:
    telegram.answer = lambda request, n: httpx.Response(
        200, json={"ok": True, "result": {"message_id": 100 + n}}
    )
    paragraph = "word " * 700  # 3,500 characters
    status, finished, logs, _ = run_telegram({"text": f"{paragraph}\n\n{paragraph}"})
    assert status == "succeeded"
    assert [len(telegram.sent(i)["text"]) for i in range(2)] == [3499, 3499]
    assert finished["output"]["message_ids"] == [101, 102]
    assert finished["output"]["message_id"] == 101
    assert logs == [("info", "Sent to 123456789 in 2 parts")]


def test_telegram_test_mode(telegram: FakeApi) -> None:
    status, finished, logs, _ = run_telegram({"test_mode": True}, key=None)
    assert status == "succeeded" and telegram.requests == []
    assert finished["output"]["sent"] is False and finished["output"]["message_ids"] == []
    assert logs == [("info", "Test mode: the message to 123456789 wasn't sent")]


@pytest.mark.parametrize(
    ("data", "key", "message"),
    [
        ({}, None, "No Telegram bot token: add one under API keys"),
        ({}, "not-a-token", "That isn't a Telegram bot token"),
        ({"chat_id": "my friend"}, TOKEN, "“my friend” isn't a Telegram chat"),
        ({"text": " "}, TOKEN, "Nothing to send"),
        ({"format": "html", "text": "x" * 4001}, TOKEN, "The message is too long for Telegram"),
        ({"text": "word " * 9000}, TOKEN, "The message is too long: it would take 12 Telegram"),
    ],
)
def test_telegram_problems(telegram: FakeApi, data: dict, key: str | None, message: str) -> None:
    status, finished, _, _ = run_telegram(data, key)
    assert status == "failed" and finished["error"].startswith(message)
    assert telegram.requests == []


@pytest.mark.parametrize(
    ("reply", "message"),
    [
        ({"ok": False, "error_code": 401, "description": "Unauthorized"}, "Telegram rejected"),
        (
            {"ok": False, "error_code": 400, "description": "Bad Request: chat not found"},
            "Telegram can't find the chat “123456789” — the user must start the bot first",
        ),
        (
            {
                "ok": False,
                "error_code": 403,
                "description": "Forbidden: bot was blocked by the user",
            },
            "The bot can't write to “123456789”: Forbidden: bot was blocked by the user",
        ),
        ({"ok": False, "error_code": 429, "description": "Too Many Requests"}, "Telegram is rate"),
        (
            {"ok": False, "error_code": 400, "description": "Bad Request: can't parse entities"},
            "Telegram didn't send the message: Bad Request: can't parse entities",
        ),
    ],
)
def test_telegram_errors(telegram: FakeApi, reply: dict, message: str) -> None:
    telegram.reply = reply
    status, finished, _, _ = run_telegram({})
    assert status == "failed" and finished["error"].startswith(message)


def test_a_failure_after_the_first_part_says_so(telegram: FakeApi) -> None:
    def second_fails(request: httpx.Request, n: int) -> httpx.Response:
        if n == 1:
            return httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})
        return httpx.Response(429, json={"ok": False, "error_code": 429, "description": "slow"})

    telegram.answer = second_fails
    paragraph = "word " * 700
    _, finished, _, _ = run_telegram({"text": f"{paragraph}\n\n{paragraph}"})
    assert finished["error"] == ("Telegram is rate-limiting messages (after sending 1 of 2 parts)")


def test_the_token_never_shows(monkeypatch: pytest.MonkeyPatch, caplog: Any) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"can't connect to {request.url}")

    monkeypatch.setattr(action_telegram, "TRANSPORT", httpx.MockTransport(refuse))
    status, finished, _, _ = run_telegram({})
    assert status == "failed"
    assert TOKEN not in finished["error"]
    assert finished["error"].startswith("Couldn't reach Telegram: can't connect to")

    # httpx's own request log (INFO) masks it too.
    with caplog.at_level(logging.INFO, logger="httpx"):
        logging.getLogger("httpx").info(
            'HTTP Request: %s %s "%s"',
            "POST",
            httpx.URL(f"https://api.telegram.org/bot{TOKEN}/sendMessage"),
            "HTTP/1.1 200 OK",
        )
    assert TOKEN not in caplog.text
    assert "https://api.telegram.org/bot…/sendMessage" in caplog.text
