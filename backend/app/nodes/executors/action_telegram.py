"""Telegram Message: sends with a bot token via the Bot API's sendMessage
(https://core.telegram.org/bots/api#sendmessage). A user must have started the bot (or the bot
must be in the group / an admin of the channel) before it can write there.

The token: the chosen saved Telegram key, else the user's newest one, else the server's
`TELEGRAM_BOT_TOKEN`. Test mode shows the message instead of sending it. The token is part of the
request URL, so it's kept out of error messages and httpx's request log.
"""

import logging
import re
from typing import Any

import httpx

from app.core.config import get_settings
from app.engine.context import NodeContext
from app.engine.executor import NodeError, NodeResult, executor
from app.nodes.executors.accounts import account_key, in_test_mode
from app.schemas.node_types import NodeType
from app.services.chunking import split_text

API_URL = "https://api.telegram.org/bot{token}/sendMessage"
TIMEOUT_SECONDS = 20
#: Telegram's limit is 4096 characters (counted in UTF-16 units); stay clear of it.
MAX_PART = 4000
MAX_PARTS = 10
#: Swapped for a mock in tests.
TRANSPORT: httpx.AsyncBaseTransport | None = None

_TOKEN = re.compile(r"^\d+:[A-Za-z0-9_-]{20,}$")
_CHAT = re.compile(r"^(-?\d+|@[A-Za-z][A-Za-z0-9_]{3,})$")
_TOKEN_IN_URL = re.compile(r"/bot\d+:[A-Za-z0-9_-]+")


class _HideTokens(logging.Filter):
    """httpx logs request URLs (at INFO): mask Telegram bot tokens in them."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if "/bot" in message:
            record.msg, record.args = _TOKEN_IN_URL.sub("/bot…", message), None
        return True


logging.getLogger("httpx").addFilter(_HideTokens())


def _parts(text: str, html: bool) -> list[str]:
    if html:
        if len(text) > MAX_PART:
            raise NodeError(
                f"The message is too long for Telegram ({len(text):,} characters, at most "
                f"{MAX_PART:,}) — HTML messages can't be split; use Plain text"
            )
        return [text]
    parts = split_text(text, MAX_PART, 0)
    if len(parts) > MAX_PARTS:
        raise NodeError(
            f"The message is too long: it would take {len(parts)} Telegram messages (at most "
            f"{MAX_PARTS})"
        )
    return parts


def _problem(data: dict[str, Any], chat_id: str) -> str:
    code = data.get("error_code")
    description = str(data.get("description") or "unknown error")
    lowered = description.lower()
    if code in (401, 404):
        return "Telegram rejected the bot token"
    if "chat not found" in lowered:
        return (
            f"Telegram can't find the chat “{chat_id}” — the user must start the bot first (or "
            "add it to the group)"
        )
    if code == 403:
        return f"The bot can't write to “{chat_id}”: {description}"
    if code == 429:
        return "Telegram is rate-limiting messages"
    return f"Telegram didn't send the message: {description}"


async def send(token: str, message: dict[str, Any]) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS, transport=TRANSPORT) as client:
            response = await client.post(API_URL.format(token=token), json=message)
    except httpx.HTTPError as exc:
        reason = str(exc).replace(token, "…")
        raise NodeError(f"Couldn't reach Telegram: {reason}") from None
    try:
        data = response.json()
    except ValueError:
        data = None
    if not isinstance(data, dict):
        raise NodeError(f"Telegram answered unexpectedly (HTTP {response.status_code})")
    if not data.get("ok"):
        raise NodeError(_problem(data, str(message["chat_id"])))
    return data.get("result") or {}


@executor(NodeType.ACTION_TELEGRAM)
async def telegram_message(ctx: NodeContext) -> NodeResult:
    chat_id = ctx.field("chat_id").strip()
    if not _CHAT.match(chat_id):
        raise NodeError(
            f"“{chat_id}” isn't a Telegram chat: use a numeric chat ID (e.g. 123456789 or "
            "-1001234567890) or a public channel's @username"
        )
    text = ctx.field("text")
    if not text.strip():
        raise NodeError("Nothing to send: the message is empty")
    html = ctx.data.get("format") == "html"
    parts = _parts(text, html)
    result = {
        "sent": False,
        "chat_id": chat_id,
        "message_id": None,
        "message_ids": [],
        "text": text,
    }

    if in_test_mode(ctx):
        ctx.log(f"Test mode: the message to {chat_id} wasn't sent")
        return NodeResult(result)

    token = await account_key(ctx, "telegram", get_settings().telegram_bot_token)
    if not token:
        raise NodeError(
            "No Telegram bot token: add one under API keys — or switch on Test mode to try the "
            "flow without sending"
        )
    if not _TOKEN.match(token):
        raise NodeError("That isn't a Telegram bot token (they look like 123456789:AAH…)")

    sent: list[int] = []
    for part in parts:
        message: dict[str, Any] = {"chat_id": chat_id, "text": part}
        if html:
            message["parse_mode"] = "HTML"
        try:
            sent.append((await send(token, message)).get("message_id"))
        except NodeError as exc:
            if not sent:
                raise
            progress = f"after sending {len(sent)} of {len(parts)} parts"
            raise NodeError(f"{exc} ({progress})") from None
    ctx.log(f"Sent to {chat_id}" + (f" in {len(parts)} parts" if len(parts) > 1 else ""))
    return NodeResult({**result, "sent": True, "message_id": sent[0], "message_ids": sent})
