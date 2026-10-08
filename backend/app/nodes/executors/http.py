"""API Caller tool: one HTTP request, built from the node's config and the agent's arguments."""

import json
import re
from typing import Any
from urllib.parse import quote

from app.engine.compiler import PlannedNode
from app.engine.context import NodeContext
from app.engine.executor import NodeError, NodeResult
from app.engine.tools import tool
from app.net import FetchError, fetch
from app.schemas.node_types import NodeType

METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
TIMEOUT_SECONDS = 30
#: Characters of a text response body returned to the agent.
BODY_MAX_CHARS = 50_000


def escape_url(value: str, before: str) -> str:
    """A reference in the middle of a URL is encoded (`?q={{input.query}}` with spaces or `&`);
    one that starts the URL (`{{input.url}}`) is used as it is."""
    return quote(value, safe="") if before else value


#: A quote preceded by an even number of backslashes (so not itself escaped).
_UNESCAPED_QUOTE = re.compile(r'(?<!\\)(?:\\\\)*"')


def escape_json_strings(value: str, before: str) -> str:
    """Inside a JSON string literal (`{"id": "{{input.id}}"}`) a value is JSON-escaped, so quotes
    and newlines in it can't break the body."""
    inside_string = len(_UNESCAPED_QUOTE.findall(before)) % 2 == 1
    return json.dumps(value, ensure_ascii=False)[1:-1] if inside_string else value


def _describe(node: PlannedNode) -> str:
    method = node.data.get("method") or "GET"
    url = node.data.get("url") or ""
    return f"Call the “{node.name}” HTTP API ({method} {url}). Returns {{status, body}}."


@tool(NodeType.TOOL_HTTP, description=_describe)
async def http_request(ctx: NodeContext) -> NodeResult:
    method = str(ctx.data.get("method") or "GET").upper()
    if method not in METHODS:
        raise NodeError(f"Unsupported method {method}")
    url = ctx.render(str(ctx.data.get("url") or ""), escape_url).strip()
    if not url:
        raise NodeError("The URL is empty")

    raw_headers = ctx.data.get("headers")
    headers: dict[str, str] = {}
    if isinstance(raw_headers, dict):
        headers = {
            str(k): v if isinstance(v, str) else json.dumps(v) for k, v in raw_headers.items()
        }

    credential_id = ctx.data.get("credential_id")
    if isinstance(credential_id, str) and credential_id:
        key = await ctx.run.secrets.get("http", credential_id)
        header = str(ctx.data.get("credential_header") or "").strip() or "Authorization"
        headers = {k: v for k, v in headers.items() if k.lower() != header.lower()}
        headers[header] = f"Bearer {key}" if header.lower() == "authorization" else (key or "")

    content: str | None = None
    body_template = ctx.data.get("body")
    if method != "GET" and isinstance(body_template, str) and body_template.strip():
        looks_like_json = body_template.strip()[:1] in ("{", "[")
        content = ctx.render(body_template, escape_json_strings if looks_like_json else None)
        if not any(k.lower() == "content-type" for k in headers):
            headers["Content-Type"] = "application/json" if looks_like_json else "text/plain"

    try:
        response = await fetch(
            method, url, headers=headers, content=content, request_timeout=TIMEOUT_SECONDS
        )
    except FetchError as exc:
        raise NodeError(str(exc)) from exc

    body: Any = response.text()
    if response.content_type.endswith("json") and not response.truncated:
        try:
            body = json.loads(body)
        except ValueError:
            pass  # keep the text
    if isinstance(body, str) and len(body) > BODY_MAX_CHARS:
        body = body[:BODY_MAX_CHARS]
    # A 4xx/5xx is a result too: the agent can read the error and react.
    return NodeResult({"status": response.status, "body": body})
