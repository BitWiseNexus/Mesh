"""Send Email (Resend, https://resend.com/docs/api-reference/emails/send-email).

The key: the chosen saved Resend key, else the user's newest one, else the server's
`RESEND_API_KEY`. Test mode skips sending and shows the email instead — for building flows
without a key (or without mailing anyone).
"""

import re
from typing import Any

import httpx

from app.core.config import get_settings
from app.engine.context import NodeContext
from app.engine.executor import NodeError, NodeResult, executor
from app.nodes.executors.accounts import account_key, in_test_mode
from app.schemas.node_types import NodeType

RESEND_URL = "https://api.resend.com/emails"
TIMEOUT_SECONDS = 20
MAX_RECIPIENTS = 50  # Resend's limit per email
#: Swapped for a mock in tests.
TRANSPORT: httpx.AsyncBaseTransport | None = None

_ADDRESS = re.compile(r"^[^@\s<>,;\"]+@[^@\s<>,;\"]+\.[^@\s<>,;\"]+$")
_NAMED = re.compile(r"^[^<>]*<([^<>]+)>$")


def valid_address(text: str) -> bool:
    """`ada@example.com` or `Ada Lovelace <ada@example.com>`."""
    named = _NAMED.match(text)
    return bool(_ADDRESS.match(named.group(1).strip() if named else text))


def recipients(text: str) -> list[str]:
    found = [a.strip() for a in re.split(r"[,;\n]", text) if a.strip()]
    if not found:
        raise NodeError("No recipient: “To” is empty")
    if len(found) > MAX_RECIPIENTS:
        raise NodeError(f"Too many recipients ({len(found)}): at most {MAX_RECIPIENTS}")
    if bad := [a for a in found if not valid_address(a)]:
        raise NodeError(f"Not an email address: “{bad[0]}”")
    return found


async def send(key: str, email: dict[str, Any]) -> str:
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS, transport=TRANSPORT) as client:
            response = await client.post(
                RESEND_URL, json=email, headers={"Authorization": f"Bearer {key}"}
            )
    except httpx.HTTPError as exc:
        raise NodeError(f"Couldn't reach Resend: {exc}") from exc
    try:
        data = response.json()
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    if response.status_code == 401 or data.get("name") in ("missing_api_key", "invalid_api_key"):
        raise NodeError("Resend rejected the API key")
    if response.status_code == 429:
        raise NodeError("Resend is rate-limiting emails (or the plan's quota is used up)")
    if response.is_error:
        detail = data.get("message") or f"error {response.status_code}"
        raise NodeError(f"Resend didn't send the email: {detail}")
    return str(data.get("id") or "")


@executor(NodeType.ACTION_EMAIL)
async def send_email(ctx: NodeContext) -> NodeResult:
    settings = get_settings()
    to = recipients(ctx.field("to"))
    subject = " ".join(ctx.field("subject").split())  # one line
    if not subject:
        raise NodeError("No subject: “Subject” is empty")
    sender = str(ctx.data.get("from_address") or "").strip() or settings.email_from
    if not valid_address(sender):
        raise NodeError(f"“From” isn't an email address: “{sender}”")
    body = ctx.field("body")
    email = {
        "from": sender,
        "to": to,
        "subject": subject,
        ("html" if ctx.data.get("format") == "html" else "text"): body,
    }
    result = {"id": None, "sent": False, "from": sender, "to": to, "subject": subject, "body": body}

    if in_test_mode(ctx):
        ctx.log(f"Test mode: “{subject}” to {', '.join(to)} wasn't sent")
        return NodeResult(result)

    key = await account_key(ctx, "resend", settings.resend_api_key)
    if not key:
        raise NodeError(
            "No Resend API key: add one under API keys — or switch on Test mode to try the flow "
            "without sending"
        )
    email_id = await send(key, email)
    ctx.log(f"Sent “{subject}” to {', '.join(to)}")
    return NodeResult({**result, "id": email_id, "sent": True})
