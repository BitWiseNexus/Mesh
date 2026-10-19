"""Slack Message: posts with a bot token (`xoxb-…`, scope `chat:write`) via chat.postMessage
(https://docs.slack.dev/reference/methods/chat.postMessage). The bot must be in the channel.

The token: the chosen saved Slack key, else the user's newest one, else the server's
`SLACK_BOT_TOKEN`. Test mode shows the message instead of posting it.
"""

from typing import Any

import httpx

from app.core.config import get_settings
from app.engine.context import NodeContext
from app.engine.executor import NodeError, NodeResult, executor
from app.nodes.executors.accounts import account_key, in_test_mode
from app.schemas.node_types import NodeType

SLACK_URL = "https://slack.com/api/chat.postMessage"
TIMEOUT_SECONDS = 20
#: Slack cuts longer messages off.
MAX_TEXT = 40_000
#: Swapped for a mock in tests.
TRANSPORT: httpx.AsyncBaseTransport | None = None

_BAD_TOKEN = "Slack rejected the bot token"
#: Slack's error codes (HTTP 200 with ok: false) → what to tell the user.
_ERRORS = {
    "invalid_auth": _BAD_TOKEN,
    "not_authed": _BAD_TOKEN,
    "token_revoked": f"{_BAD_TOKEN} (it was revoked)",
    "token_expired": f"{_BAD_TOKEN} (it expired)",
    "account_inactive": f"{_BAD_TOKEN} (the bot's account is inactive)",
    "missing_scope": "The bot token lacks the chat:write permission",
    "channel_not_found": "Slack can't find the channel “{channel}” — use its name or ID, and "
    "invite the bot to it",
    "not_in_channel": "The bot isn't in “{channel}” — invite it there first",
    "is_archived": "The channel “{channel}” is archived",
    "msg_too_long": "The message is too long for Slack",
    "ratelimited": "Slack is rate-limiting messages",
}


async def post(token: str, channel: str, text: str) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS, transport=TRANSPORT) as client:
            response = await client.post(
                SLACK_URL,
                json={"channel": channel, "text": text},
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError as exc:
        raise NodeError(f"Couldn't reach Slack: {exc}") from exc
    if response.status_code == 429:
        raise NodeError(_ERRORS["ratelimited"])
    try:
        data = response.json()
    except ValueError:
        data = None
    if not isinstance(data, dict):
        raise NodeError(f"Slack answered unexpectedly (HTTP {response.status_code})")
    if not data.get("ok"):
        code = str(data.get("error") or "unknown_error")
        message = _ERRORS.get(code, "Slack didn't post the message: {code}")
        raise NodeError(message.format(channel=channel, code=code))
    return data


@executor(NodeType.ACTION_SLACK)
async def slack_message(ctx: NodeContext) -> NodeResult:
    channel = ctx.field("channel").strip()
    if not channel:
        raise NodeError("No channel: “Channel” is empty")
    text = ctx.field("text")
    if not text.strip():
        raise NodeError("Nothing to send: the message is empty")
    if len(text) > MAX_TEXT:
        ctx.log(f"Slack shows at most {MAX_TEXT:,} characters: the rest is cut off", "warning")
    result = {"sent": False, "channel": channel, "ts": None, "text": text}

    if in_test_mode(ctx):
        ctx.log(f"Test mode: the message to {channel} wasn't posted")
        return NodeResult(result)

    token = await account_key(ctx, "slack", get_settings().slack_bot_token)
    if not token:
        raise NodeError(
            "No Slack bot token: add one under API keys — or switch on Test mode to try the flow "
            "without posting"
        )
    posted = await post(token, channel, text)
    ctx.log(f"Posted to {channel}")
    return NodeResult(
        {**result, "sent": True, "channel": posted.get("channel", channel), "ts": posted.get("ts")}
    )
