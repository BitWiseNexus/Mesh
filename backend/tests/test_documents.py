"""Knowledge-base documents: file checks, and upload / list / delete through the API (Firestore and
Storage emulators)."""

import urllib.request
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

import app.api.knowledge as knowledge_api
import app.llm.models as models
import app.repositories.knowledge as knowledge_repo
import app.services.documents as documents
from app.core.auth import AuthUser, get_current_user
from app.core.errors import ApiError
from app.core.firebase import get_bucket, get_db
from app.main import app
from tests.conftest import (
    FIRESTORE_EMULATOR,
    requires_firestore_emulator,
    requires_storage_emulator,
)

CLEAR_URL = f"{FIRESTORE_EMULATOR}/emulator/v1/projects/demo-mesh/databases/(default)/documents"
PDF = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"


@pytest.mark.parametrize(
    ("filename", "data", "name", "mime"),
    [
        ("faq.md", b"# FAQ\n", "faq.md", "text/markdown"),
        ("notes.MARKDOWN", b"x", "notes.MARKDOWN", "text/markdown"),
        ("readme.txt", "\ufeffcaf\u00e9".encode(), "readme.txt", "text/plain"),  # BOM ok
        ("manual.pdf", PDF, "manual.pdf", "application/pdf"),
        ("C:\\Users\\a\\report.txt", b"x", "report.txt", "text/plain"),  # a Windows path
        ("../../etc/x.txt", b"x", "x.txt", "text/plain"),
    ],
)
def test_accepted_files(filename: str, data: bytes, name: str, mime: str) -> None:
    checked = documents.check_file(filename, data)
    assert (checked.name, checked.mime, checked.data) == (name, mime, data)


@pytest.mark.parametrize(
    ("filename", "data", "code", "message"),
    [
        ("image.png", b"\x89PNG", "unsupported_document_type", "Upload PDF"),
        ("no-extension", b"x", "unsupported_document_type", "Upload PDF"),
        ("", b"x", "unsupported_document_type", "needs a name"),
        ("fake.pdf", b"hello", "unsupported_document_type", "isn't a valid PDF"),
        ("latin1.txt", "caf\u00e9".encode("latin-1"), "unsupported_document_type", "UTF-8"),
        ("binary.txt", b"a\x00b", "unsupported_document_type", "binary"),
        ("empty.md", b"", "empty_document", "empty"),
    ],
)
def test_refused_files(filename: str, data: bytes, code: str, message: str) -> None:
    with pytest.raises(ApiError) as caught:
        documents.check_file(filename, data)
    assert caught.value.code == code and message in caught.value.message


def test_size_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(documents, "MAX_DOCUMENT_BYTES", 10)
    documents.check_file("a.txt", b"x" * 10)
    with pytest.raises(documents.DocumentTooLargeError):
        documents.check_file("a.txt", b"x" * 11)


def test_long_names_are_shortened() -> None:
    assert len(documents.check_file("a" * 300 + ".txt", b"x").name) == 200


# ── API (Firestore + Storage emulators) ───────────────────────────────────


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    urllib.request.urlopen(urllib.request.Request(CLEAR_URL, method="DELETE"), timeout=5)
    monkeypatch.setattr(models, "server_has_key", lambda provider: False)
    get_db.cache_clear()
    with TestClient(app) as test_client:
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="alice")
        yield test_client
    app.dependency_overrides.clear()
    get_db.cache_clear()


def new_kb(client: TestClient) -> str:
    response = client.post("/knowledge-bases", json={"name": "Docs"})
    assert response.status_code == 201
    return response.json()["knowledge_base_id"]


def upload(
    client: TestClient, kb_id: str, name: str = "faq.md", data: bytes = b"# FAQ\nYes."
) -> Any:
    files = {"file": (name, data, "application/octet-stream")}
    return client.post(f"/knowledge-bases/{kb_id}/documents", files=files)


def stored(path: str) -> bool:
    return get_bucket().blob(path).exists()


@requires_firestore_emulator
@requires_storage_emulator
class TestDocumentsApi:
    def test_upload_list_delete(self, client: TestClient) -> None:
        kb_id = new_kb(client)
        first = upload(client, kb_id)
        assert first.status_code == 201, first.text
        doc = first.json()
        assert doc | {"document_id": "x", "created_at": "x", "updated_at": "x"} == {
            "document_id": "x",
            "name": "faq.md",
            "mime": "text/markdown",
            "size": 10,
            "status": "pending",
            "error": None,
            "chunk_count": 0,
            "created_at": "x",
            "updated_at": "x",
        }
        path = documents.file_path("alice", kb_id, doc["document_id"])
        assert get_bucket().blob(path).download_as_bytes() == b"# FAQ\nYes."
        assert upload(client, kb_id, "manual.pdf", PDF).status_code == 201

        listed = client.get(f"/knowledge-bases/{kb_id}/documents").json()
        assert [d["name"] for d in listed] == ["manual.pdf", "faq.md"]  # newest first
        assert client.get(f"/knowledge-bases/{kb_id}").json()["document_count"] == 2

        deleted = client.delete(f"/knowledge-bases/{kb_id}/documents/{doc['document_id']}")
        assert deleted.status_code == 204
        assert not stored(path)
        assert [d["name"] for d in client.get(f"/knowledge-bases/{kb_id}/documents").json()] == [
            "manual.pdf"
        ]
        assert client.get(f"/knowledge-bases/{kb_id}").json()["document_count"] == 1
        again = client.delete(f"/knowledge-bases/{kb_id}/documents/{doc['document_id']}")
        assert again.status_code == 404
        assert again.json()["detail"]["code"] == "document_not_found"

    def test_the_embedding_model_is_locked_once_there_are_documents(
        self, client: TestClient
    ) -> None:
        kb_id = new_kb(client)
        upload(client, kb_id)
        response = client.patch(
            f"/knowledge-bases/{kb_id}", json={"embedding_model": "text-embedding-3-small"}
        )
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "embedding_model_locked"

    def test_refused_uploads_store_nothing(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        kb_id = new_kb(client)
        bad = upload(client, kb_id, "photo.png", b"\x89PNG")
        assert bad.status_code == 415
        assert bad.json()["detail"]["code"] == "unsupported_document_type"

        monkeypatch.setattr(knowledge_api, "MAX_DOCUMENT_BYTES", 5)
        monkeypatch.setattr(documents, "MAX_DOCUMENT_BYTES", 5)
        too_big = upload(client, kb_id, "big.txt", b"x" * 6)
        assert too_big.status_code == 413
        assert too_big.json()["detail"]["code"] == "document_too_large"

        monkeypatch.setattr(knowledge_repo, "MAX_DOCUMENTS", 1)
        assert upload(client, kb_id, "ok.md", b"ok").status_code == 201  # (under the 5 bytes)
        full = upload(client, kb_id, "second.md", b"ok")
        assert full.status_code == 409 and full.json()["detail"]["code"] == "too_many_documents"
        # Only the accepted document's file was kept.
        assert len(list(get_bucket().list_blobs(prefix=documents.folder("alice", kb_id)))) == 1
        assert client.get(f"/knowledge-bases/{kb_id}").json()["document_count"] == 1

    def test_other_users_documents_look_missing(self, client: TestClient) -> None:
        kb_id = new_kb(client)
        doc_id = upload(client, kb_id).json()["document_id"]
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="bob")
        for response in (
            client.get(f"/knowledge-bases/{kb_id}/documents"),
            upload(client, kb_id),
            client.delete(f"/knowledge-bases/{kb_id}/documents/{doc_id}"),
        ):
            assert response.status_code == 404
            assert response.json()["detail"]["code"] == "knowledge_base_not_found"
        assert stored(documents.file_path("alice", kb_id, doc_id))
        assert not list(get_bucket().list_blobs(prefix=documents.folder("bob", kb_id)))

    def test_deleting_a_knowledge_base_deletes_its_files(self, client: TestClient) -> None:
        kb_id = new_kb(client)
        upload(client, kb_id)
        upload(client, kb_id, "b.txt", b"b")
        folder = documents.folder("alice", kb_id)
        assert len(list(get_bucket().list_blobs(prefix=folder))) == 2
        assert client.delete(f"/knowledge-bases/{kb_id}").status_code == 204
        assert not list(get_bucket().list_blobs(prefix=folder))
