"""Processing documents into chunks (app/services/ingestion.py) through the API — Firestore and
Storage emulators; mock embeddings unless a test fakes a provider."""

import asyncio
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient
from google.cloud.firestore_v1 import FieldFilter

import app.services.ingestion as ingestion
from app.core.firebase import get_db
from app.llm import LlmError
from app.main import app
from app.repositories.chunks import COLLECTION as CHUNKS
from tests.conftest import requires_firestore_emulator, requires_storage_emulator
from tests.knowledge import new_kb, upload
from tests.pdfs import make_pdf


@pytest.fixture
def client(kb_client: TestClient) -> TestClient:
    return kb_client


FAQ = "\n\n".join(
    f"Question {i}: how does feature {i} work? Answer: feature {i} works by doing step {i}."
    for i in range(40)
)


def documents(client: TestClient, kb_id: str) -> list[dict[str, Any]]:
    return client.get(f"/knowledge-bases/{kb_id}/documents").json()


def wait_until_settled(client: TestClient, kb_id: str, timeout: float = 15) -> list[dict]:
    """Polls the list (as the page does) until no document is pending or processing."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = documents(client, kb_id)
        if all(d["status"] in ("ready", "failed") for d in found):
            return found
        time.sleep(0.1)
    raise AssertionError(f"still processing: {documents(client, kb_id)}")


def chunks_of(kb_id: str, doc_id: str | None = None) -> list[dict[str, Any]]:
    get_db.cache_clear()

    async def query() -> list[dict[str, Any]]:
        q = get_db().collection(CHUNKS).where(filter=FieldFilter("kb_id", "==", kb_id))
        if doc_id:
            q = q.where(filter=FieldFilter("doc_id", "==", doc_id))
        return [s.to_dict() async for s in q.stream()]

    try:
        return asyncio.run(query())
    finally:
        get_db.cache_clear()


@requires_firestore_emulator
@requires_storage_emulator
class TestIngestion:
    def test_uploads_become_searchable_chunks(self, client: TestClient) -> None:
        kb_id = new_kb(client)
        client.patch(f"/knowledge-bases/{kb_id}", json={"chunk_size": 400, "chunk_overlap": 50})
        md = upload(client, kb_id, "faq.md", FAQ.encode()).json()
        pdf = upload(client, kb_id, "guide.pdf", make_pdf(["Install it first.", "Then run it."]))
        assert pdf.status_code == 201
        settled = {d["name"]: d for d in wait_until_settled(client, kb_id)}
        assert settled["faq.md"]["status"] == "ready" and settled["faq.md"]["error"] is None
        assert settled["faq.md"]["chunk_count"] > 5

        stored = sorted(chunks_of(kb_id, md["document_id"]), key=lambda c: c["index"])
        assert len(stored) == settled["faq.md"]["chunk_count"]
        assert [c["index"] for c in stored] == list(range(len(stored)))
        assert all(len(c["text"]) <= 400 for c in stored)
        assert stored[0]["owner_uid"] == "alice" and stored[0]["page"] is None
        assert len(list(stored[0]["embedding"])) == 768

        pdf_chunks = chunks_of(kb_id, pdf.json()["document_id"])
        assert settled["guide.pdf"]["chunk_count"] == 1
        assert pdf_chunks[0]["page"] == 1 and "Then run it." in pdf_chunks[0]["text"]

    def test_failures_are_recorded_on_the_document(self, client: TestClient) -> None:
        kb_id = new_kb(client)
        upload(client, kb_id, "blank.md", b"   \n\n  ")
        upload(client, kb_id, "scan.pdf", make_pdf([""]))
        # A model needing a key nobody has (the test server has none): no API key for OpenAI.
        other = client.post(
            "/knowledge-bases", json={"name": "Keyed", "embedding_model": "text-embedding-3-small"}
        ).json()["knowledge_base_id"]
        upload(client, other, "a.md", b"Some text.")

        failed = {d["name"]: d for d in wait_until_settled(client, kb_id)}
        assert failed["blank.md"]["status"] == "failed"
        assert failed["blank.md"]["error"] == "No text found in this document."
        assert "Scanned PDFs" in failed["scan.pdf"]["error"]
        keyed = wait_until_settled(client, other)[0]
        assert keyed["status"] == "failed" and keyed["error"].startswith("No API key for OpenAI")
        assert chunks_of(kb_id) == [] and chunks_of(other) == []

    def test_unexpected_errors_are_logged_not_shown(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def broken(*args: Any, **kwargs: Any) -> list[list[float]]:
            raise RuntimeError("database exploded")

        monkeypatch.setattr(ingestion, "embed", broken)
        kb_id = new_kb(client)
        upload(client, kb_id, "a.md", b"Text.")
        document = wait_until_settled(client, kb_id)[0]
        assert document["error"] == "Unexpected error while processing it."

    def test_provider_errors_are_shown(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def rate_limited(*args: Any, **kwargs: Any) -> list[list[float]]:
            raise LlmError("OpenAI is rate-limiting requests.")

        monkeypatch.setattr(ingestion, "embed", rate_limited)
        kb_id = new_kb(client)
        upload(client, kb_id, "a.md", b"Text.")
        assert wait_until_settled(client, kb_id)[0]["error"] == "OpenAI is rate-limiting requests."

    def test_deleting_removes_chunks(self, client: TestClient) -> None:
        kb_id = new_kb(client)
        first = upload(client, kb_id, "a.md", FAQ.encode()).json()
        upload(client, kb_id, "b.md", FAQ.encode())
        wait_until_settled(client, kb_id)
        assert chunks_of(kb_id, first["document_id"])
        client.delete(f"/knowledge-bases/{kb_id}/documents/{first['document_id']}")
        assert chunks_of(kb_id, first["document_id"]) == []
        assert chunks_of(kb_id)  # the other document's are still there
        client.delete(f"/knowledge-bases/{kb_id}")
        assert chunks_of(kb_id) == []

    def test_unfinished_documents_are_picked_up_again(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A document left pending/processing (the server restarted) is processed when listed."""
        submitted: list[Any] = []
        monkeypatch.setattr(
            app.state.ingestion, "submit", lambda job: submitted.append(job), raising=True
        )
        kb_id = new_kb(client)
        doc_id = upload(client, kb_id, "a.md", b"Text.").json()["document_id"]
        assert [j.document_id for j in submitted] == [doc_id]  # queued on upload
        monkeypatch.undo()  # back to the real manager: as if the earlier task had been lost
        assert documents(client, kb_id)[0]["status"] == "pending"
        assert wait_until_settled(client, kb_id)[0]["status"] == "ready"

    def test_failed_documents_can_be_retried(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = 0

        async def flaky(*args: Any, **kwargs: Any) -> list[list[float]]:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise LlmError("No API key for OpenAI.")
            return [[1.0] + [0.0] * 767 for _ in args[1]]

        monkeypatch.setattr(ingestion, "embed", flaky)
        kb_id = new_kb(client)
        doc_id = upload(client, kb_id, "a.md", b"Text.").json()["document_id"]
        assert wait_until_settled(client, kb_id)[0]["status"] == "failed"
        retried = client.post(f"/knowledge-bases/{kb_id}/documents/{doc_id}/retry")
        assert retried.status_code == 200
        assert retried.json()["status"] in ("pending", "processing", "ready")
        assert retried.json()["error"] is None
        settled = wait_until_settled(client, kb_id)[0]
        assert (settled["status"], settled["chunk_count"]) == ("ready", 1)
        missing = client.post(f"/knowledge-bases/{kb_id}/documents/nope/retry")
        assert missing.status_code == 404
        assert missing.json()["detail"]["code"] == "document_not_found"
