"""Helpers for the knowledge-base API tests (client: the `kb_client` fixture)."""

from typing import Any

from fastapi.testclient import TestClient


def new_kb(client: TestClient) -> str:
    response = client.post("/knowledge-bases", json={"name": "Docs"})
    assert response.status_code == 201
    return response.json()["knowledge_base_id"]


def upload(
    client: TestClient, kb_id: str, name: str = "faq.md", data: bytes = b"# FAQ\nYes."
) -> Any:
    files = {"file": (name, data, "application/octet-stream")}
    return client.post(f"/knowledge-bases/{kb_id}/documents", files=files)
