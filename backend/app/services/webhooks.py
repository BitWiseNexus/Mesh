"""Webhook triggers: what the trigger outputs for a request, and per-webhook rate limiting.

The Webhook trigger outputs the request as `{method, query, headers, body}`:
- `query` (and form-encoded bodies): one value → text, a repeated name → a list of texts
- `headers`: lower-case names, repeated ones joined with ", "; credentials (Authorization,
  Cookie, X-Mesh-Secret…) are left out, so they never reach the flow or the run's record
- `body`: JSON (`application/json`, `*/*+json`) → parsed; form-encoded → its fields; anything
  else → UTF-8 text; empty → null. Binary bodies are refused.
"""

import json
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
