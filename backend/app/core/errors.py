"""Domain errors that map to API responses with the standard `{"detail": {code, message}}` body."""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class ApiError(Exception):
    status_code = 400
    code = "bad_request"
    message = "Bad request."

    def __init__(self, message: str | None = None, **extra: object) -> None:
        super().__init__(message or self.message)
        self.message = message or self.message
        self.extra = extra


class NotFoundError(ApiError):
    status_code = 404
    code = "not_found"
    message = "Not found."


class ConflictError(ApiError):
    status_code = 409
    code = "conflict"
    message = "Conflict."


class PayloadTooLargeError(ApiError):
    status_code = 413
    code = "payload_too_large"
    message = "Payload too large."


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _handle(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": {"code": exc.code, "message": exc.message, **exc.extra}},
        )
