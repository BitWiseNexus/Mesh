"""Unanticipated failures become readable JSON errors with CORS headers (core/middleware.py)."""

import asyncio
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
from google.api_core import exceptions as google_errors

from app.api.flows import get_flow_repository
from app.core.auth import AuthUser, get_current_user
from app.core.errors import NotFoundError, register_error_handlers
from app.core.middleware import ErrorGuardMiddleware
from app.main import app as real_app

ORIGIN = {"Origin": "http://localhost:3000"}


def make_app(timeout: float = 0.2) -> FastAPI:
    app = FastAPI()
    app.add_middleware(ErrorGuardMiddleware, timeout=timeout)
    app.add_middleware(
        CORSMiddleware, allow_origins=["http://localhost:3000"], allow_credentials=True
    )
    register_error_handlers(app)

    @app.get("/crash")
    async def crash() -> None:
        raise RuntimeError("boom")

    @app.get("/database")
    async def database() -> None:
        raise google_errors.ServiceUnavailable("connection refused")

    @app.get("/slow")
    async def slow() -> None:
        await asyncio.sleep(5)

    @app.post("/upload")
    async def upload() -> dict[str, bool]:
        await asyncio.sleep(0.4)  # longer than the timeout
        return {"ok": True}

    @app.post("/hooks/f/n")
    async def webhook() -> dict[str, bool]:
        await asyncio.sleep(0.4)  # waiting for the flow's answer: longer than the timeout
        return {"ok": True}

    @app.get("/missing")
    async def missing() -> None:
        raise NotFoundError()

    @app.get("/runs/r/stream")
    async def stream() -> StreamingResponse:
        async def body():
            await asyncio.sleep(0.4)  # longer than the timeout: streams are exempt
            yield b"data: ok\n\n"

        return StreamingResponse(body(), media_type="text/event-stream")

    return app


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(make_app()) as test_client:
        yield test_client


@pytest.mark.parametrize(
    ("path", "status", "code"),
    [
        ("/crash", 500, "internal_error"),
        ("/database", 503, "database_unavailable"),
        ("/slow", 503, "server_timeout"),
    ],
)
def test_failures_are_json_with_cors_headers(
    client: TestClient, path: str, status: int, code: str
) -> None:
    response = client.get(path, headers=ORIGIN)
    assert response.status_code == status
    assert response.json()["detail"]["code"] == code
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_messages_point_at_the_emulators_for_database_problems(client: TestClient) -> None:
    for path in ("/database", "/slow"):
        assert "Firebase emulators are running" in client.get(path).json()["detail"]["message"]
    assert client.get("/crash").json()["detail"]["message"] == (
        "Something went wrong on the server. Please try again."
    )


def test_domain_errors_are_untouched(client: TestClient) -> None:
    response = client.get("/missing", headers=ORIGIN)
    assert response.status_code == 404 and response.json()["detail"]["code"] == "not_found"


def test_event_streams_have_no_timeout(client: TestClient) -> None:
    response = client.get("/runs/r/stream")
    assert response.status_code == 200 and response.text == "data: ok\n\n"


def test_uploads_get_more_time(client: TestClient) -> None:
    """A multipart body takes as long as the connection needs: it gets `upload_timeout`."""
    uploaded = client.post("/upload", files={"file": ("a.txt", b"hello", "text/plain")})
    assert uploaded.status_code == 200
    assert client.post("/upload", json={"x": 1}).status_code == 503


def test_webhooks_get_more_time(client: TestClient) -> None:
    assert client.post("/hooks/f/n").status_code == 200


def test_the_real_app_answers_a_down_database_with_503_and_cors() -> None:
    class DownRepository:
        async def list(self, owner_uid: str) -> None:
            raise google_errors.ServiceUnavailable("failed to connect to 127.0.0.1:8080")

    real_app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="alice")
    real_app.dependency_overrides[get_flow_repository] = lambda: DownRepository()
    try:
        with TestClient(real_app) as test_client:
            response = test_client.get("/flows", headers=ORIGIN)
    finally:
        real_app.dependency_overrides.clear()
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "database_unavailable"
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
