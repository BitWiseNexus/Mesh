"""Turns failures the API didn't anticipate into proper JSON errors the browser can read.

Starlette answers unhandled exceptions from its outermost layer, outside CORSMiddleware, so the
browser drops those responses as CORS failures and the frontend only sees "network error". This
middleware sits inside CORSMiddleware and answers instead, with the usual `{"detail": {code,
message}}` body:

- database unreachable (e.g. the Firestore emulator isn't running) → 503 `database_unavailable`
- a request taking longer than `timeout` (the Firestore client retries an unreachable database
  for minutes) → 503 `server_timeout`; event streams (`…/stream`) are exempt
- anything else → 500 `internal_error`, logged with its traceback

Domain errors (ApiError, HTTPException, validation) never get here: FastAPI handles them first.
"""

import asyncio
import logging

from fastapi.responses import JSONResponse
from google.api_core import exceptions as google_errors
from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)

DATABASE_HINT = "In development, check that the Firebase emulators are running (npm run dev)."

_UNREACHABLE = (
    google_errors.ServiceUnavailable,
    google_errors.DeadlineExceeded,
    google_errors.RetryError,
)


def describe(exc: BaseException) -> tuple[int, str, str]:
    if isinstance(exc, TimeoutError):
        return (
            503,
            "server_timeout",
            f"The server took too long to answer — the database may be unreachable. "
            f"{DATABASE_HINT}",
        )
    if isinstance(exc, _UNREACHABLE):
        return 503, "database_unavailable", f"The database isn't reachable. {DATABASE_HINT}"
    return 500, "internal_error", "Something went wrong on the server. Please try again."


class ErrorGuardMiddleware:
    def __init__(self, app: ASGIApp, timeout: float) -> None:
        self.app = app
        self.timeout = timeout

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        streaming = scope["path"].endswith("/stream")
        try:
            if streaming:
                await self.app(scope, receive, tracking_send)
            else:
                async with asyncio.timeout(self.timeout):
                    await self.app(scope, receive, tracking_send)
        except Exception as exc:
            if started:
                raise  # the response is already on its way; nothing better to send
            status, code, message = describe(exc)
            if status == 500:
                logger.exception("Unhandled error in %s %s", scope["method"], scope["path"])
            else:
                logger.warning("%s %s → %s (%s)", scope["method"], scope["path"], code, exc)
            response = JSONResponse(
                {"detail": {"code": code, "message": message}}, status_code=status
            )
            await response(scope, receive, send)
