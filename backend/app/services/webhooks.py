"""Webhook triggers: what the trigger outputs for a request, the HTTP Response node's answer, and
per-webhook rate limiting.

The Webhook trigger outputs the request as `{method, query, headers, body}`:
- `query` (and form-encoded bodies): one value → text, a repeated name → a list of texts
- `headers`: lower-case names, repeated ones joined with ", "; credentials (Authorization,
  Cookie, X-Mesh-Secret…) are left out, so they never reach the flow or the run's record
- `body`: JSON (`application/json`, `*/*+json`) → parsed; form-encoded → its fields; anything
  else → UTF-8 text; empty → null. Binary bodies are refused.
"""

import json
import re
import time
from collections import deque
from collections.abc import Callable, Iterable
from typing import Any
from urllib.parse import parse_qsl

from app.core.errors import ApiError

SECRET_HEADER = "x-mesh-secret"
HIDDEN_HEADERS = frozenset({"authorization", "proxy-authorization", "cookie", SECRET_HEADER})


class InvalidBodyError(ApiError):
    status_code = 400
    code = "invalid_body"
    message = "The request body couldn't be read."


class UnsupportedBodyError(ApiError):
    status_code = 415
    code = "unsupported_body"
    message = "Send JSON, form fields or text — binary bodies aren't supported."


def webhook_request(method: str, query: dict[str, Any], headers: dict[str, str], body: Any) -> dict:
    return {"method": method, "query": query, "headers": headers, "body": body}


def collect_fields(pairs: Iterable[tuple[str, str]]) -> dict[str, str | list[str]]:
    fields: dict[str, Any] = {}
    for name, value in pairs:
        if name not in fields:
            fields[name] = value
        elif isinstance(fields[name], list):
            fields[name].append(value)
        else:
            fields[name] = [fields[name], value]
    return fields


def visible_headers(pairs: Iterable[tuple[str, str]]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for name, value in pairs:
        name = name.lower()
        if name not in HIDDEN_HEADERS:
            headers[name] = f"{headers[name]}, {value}" if name in headers else value
    return headers


def parse_body(content_type: str, raw: bytes) -> Any:
    if not raw:
        return None
    media_type = content_type.split(";", 1)[0].strip().lower()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise UnsupportedBodyError() from None
    if media_type == "application/json" or media_type.endswith("+json"):
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise InvalidBodyError(
                f"The body isn't valid JSON: {exc.msg} (line {exc.lineno}, column {exc.colno})."
            ) from None
    if media_type == "application/x-www-form-urlencoded":
        return collect_fields(parse_qsl(text, keep_blank_values=True))
    if "\x00" in text:
        raise UnsupportedBodyError()
    return text


def stand_in_body(text: str) -> Any:
    """Runs started from the editor: the trigger's Test body stands in for the request body,
    parsed when it's JSON."""
    if not text.strip():
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


class RateLimiter:
    """At most `limit` hits per `window` seconds for each key (sliding window, this process only —
    like live runs, it assumes a single backend instance)."""

    MAX_KEYS = 10_000

    def __init__(
        self, limit: int, window: float = 60, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.limit = limit
        self.window = window
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}

    def hit(self, key: str) -> float | None:
        """Counts a hit and returns None, or — over the limit — the seconds until the next one
        would be allowed (not counted)."""
        now = self._clock()
        hits = self._hits.setdefault(key, deque())
        while hits and hits[0] <= now - self.window:
            hits.popleft()
        if len(hits) >= self.limit:
            return hits[0] + self.window - now
        hits.append(now)
        if len(self._hits) > self.MAX_KEYS:
            self._hits = {k: v for k, v in self._hits.items() if v and v[-1] > now - self.window}
        return None


# ── HTTP Response node ────────────────────────────────────────────────────

_HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
#: Set by the server from the body; a flow can't override them.
_RESERVED_HEADERS = frozenset({"content-length", "transfer-encoding", "connection"})
_TEXT_TYPES = {"text/plain": "text/plain; charset=utf-8", "text/html": "text/html; charset=utf-8"}
NO_BODY_STATUSES = frozenset({204, 304})


class ResponseError(ValueError):
    """A user-facing problem with what the HTTP Response node was asked to send."""


def _body_text(body: Any, content_type: str) -> tuple[str, str]:
    """(text, Content-Type) for the body value an HTTP Response node rendered."""
    if content_type == "auto":
        if isinstance(body, dict | list | bool | int | float):
            content_type = "application/json"
        else:
            return ("" if body is None else str(body)), _TEXT_TYPES["text/plain"]
    if content_type == "application/json":
        if isinstance(body, str):
            try:
                json.loads(body)
            except json.JSONDecodeError as exc:
                raise ResponseError(
                    f"The body isn't valid JSON ({exc.msg}, line {exc.lineno} column "
                    f"{exc.colno}) — use Text, or make it JSON."
                ) from None
            return body, "application/json"
        return json.dumps(body, ensure_ascii=False), "application/json"
    if content_type not in _TEXT_TYPES:
        raise ResponseError(f"Unsupported content type “{content_type}”.")
    if isinstance(body, str):
        return body, _TEXT_TYPES[content_type]
    text = "" if body is None else json.dumps(body, ensure_ascii=False, indent=2)
    return text, _TEXT_TYPES[content_type]


def build_response(status_code: Any, content_type: str, headers: Any, body: Any) -> dict:
    """What the HTTP Response node outputs, and the webhook caller gets:
    `{status_code, headers, body}` with `body` the exact text sent."""
    if not isinstance(status_code, int) or isinstance(status_code, bool):
        raise ResponseError("The status code must be a whole number.")
    if not 200 <= status_code <= 599:
        raise ResponseError("The status code must be between 200 and 599.")
    if not isinstance(headers, dict):
        raise ResponseError("Extra headers must be a JSON object.")
    sent: dict[str, str] = {}
    if status_code in NO_BODY_STATUSES:
        text = ""
    else:
        text, sent["Content-Type"] = _body_text(body, content_type)
    for name, value in headers.items():
        if not _HEADER_NAME.match(name):
            raise ResponseError(f"“{name}” isn't a valid header name.")
        if name.lower() in _RESERVED_HEADERS:
            raise ResponseError(f"The server sets {name} itself.")
        if isinstance(value, dict | list) or value is None:
            raise ResponseError(f"The {name} header needs a text value.")
        value = str(value).lower() if isinstance(value, bool) else str(value)
        if any(c in value for c in "\r\n"):
            raise ResponseError(f"The {name} header can't contain line breaks.")
        if name.lower() == "content-type":
            sent.pop("Content-Type", None)  # an explicit Content-Type wins
        sent[name] = value
    return {"status_code": status_code, "headers": sent, "body": text}
