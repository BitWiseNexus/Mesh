"""Knowledge bases: the /knowledge-bases API (Firestore emulator) and embedding-model choice."""

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

import app.repositories.knowledge as knowledge_repo
from app.core.auth import AuthUser, get_current_user
from app.core.config import Settings
from app.core.firebase import get_db
from app.llm import embeddings
from app.main import app
from tests.conftest import FIRESTORE_EMULATOR, requires_firestore_emulator

CLEAR_URL = f"{FIRESTORE_EMULATOR}/emulator/v1/projects/demo-mesh/databases/(default)/documents"


def mocks(monkeypatch: pytest.MonkeyPatch, *, enabled: bool) -> None:
    settings = Settings(
        environment="development" if enabled else "production",
        use_firebase_emulators=enabled,
    )
    monkeypatch.setattr(embeddings, "get_settings", lambda: settings)


@pytest.mark.parametrize(
    ("saved", "server", "mock_models", "expected"),
    [
        (["anthropic", "gemini"], {"openai"}, True, "gemini-embedding-001"),  # newest usable key
        ([], {"gemini", "openai"}, True, "text-embedding-3-small"),  # model order
        (["anthropic"], set(), True, "mock/embedding"),  # Anthropic has no embeddings
        ([], set(), False, "text-embedding-3-small"),  # production: never the mock
    ],
)
def test_default_embedding_model(
    monkeypatch: pytest.MonkeyPatch,
    saved: list[str],
    server: set[str],
    mock_models: bool,
    expected: str,
) -> None:
    mocks(monkeypatch, enabled=mock_models)
    assert embeddings.default_embedding_model(saved, server) == expected


def test_the_mock_embedding_model_is_only_offered_outside_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mocks(monkeypatch, enabled=False)
    assert not embeddings.is_embedding_model("mock/embedding")
    assert embeddings.is_embedding_model("gemini-embedding-001")
    mocks(monkeypatch, enabled=True)
    assert embeddings.is_embedding_model("mock/embedding")


# ── API (Firestore emulator) ──────────────────────────────────────────────


@pytest.fixture
def client(kb_client: TestClient) -> TestClient:
    return kb_client


def as_user(uid: str) -> None:
    app.dependency_overrides[get_current_user] = lambda: AuthUser(uid=uid)


def create(client: TestClient, **body: Any) -> dict[str, Any]:
    response = client.post("/knowledge-bases", json={"name": "Product docs"} | body)
    assert response.status_code == 201, response.text
    return response.json()


def set_field(knowledge_base_id: str, **fields: Any) -> None:
    """Changes a stored knowledge base directly (e.g. as if documents had been added)."""
    get_db.cache_clear()

    async def update() -> None:
        await get_db().collection("knowledge_bases").document(knowledge_base_id).update(fields)

    asyncio.run(update())
    get_db.cache_clear()


@requires_firestore_emulator
class TestKnowledgeBasesApi:
    def test_create_list_get(self, client: TestClient) -> None:
        kb = create(client, description=" FAQ and manuals ")
        assert kb["name"] == "Product docs" and kb["description"] == "FAQ and manuals"
        assert kb["embedding_model"] == "mock/embedding"  # no keys anywhere (development)
        assert (kb["chunk_size"], kb["chunk_overlap"], kb["document_count"]) == (1000, 150, 0)
        other = create(client, name="Support", chunk_size=500, chunk_overlap=0)
        names = [k["name"] for k in client.get("/knowledge-bases").json()]
        assert names == ["Support", "Product docs"]  # most recently changed first
        got = client.get(f"/knowledge-bases/{kb['knowledge_base_id']}")
        assert got.status_code == 200 and got.json() == kb
        assert other["chunk_size"] == 500

    def test_the_default_model_follows_the_users_keys(self, client: TestClient) -> None:
        response = client.post(
            "/credentials", json={"provider": "gemini", "name": "Gemini", "value": "key-12345678"}
        )
        assert response.status_code == 201
        assert create(client)["embedding_model"] == "gemini-embedding-001"
        assert create(client, embedding_model="text-embedding-3-small")["embedding_model"] == (
            "text-embedding-3-small"
        )
        models_body = client.get("/models").json()
        assert models_body["default_embedding_model"] == "gemini-embedding-001"
        keys = {m["id"]: m["key"] for m in models_body["embedding_models"]}
        assert keys == {
            "text-embedding-3-small": "none",
            "gemini-embedding-001": "saved",
            "mock/embedding": "not_needed",
        }

    @pytest.mark.parametrize(
        ("body", "status", "code"),
        [
            ({"name": ""}, 422, None),
            ({"name": "x" * 101}, 422, None),
            ({"chunk_size": 100}, 422, None),
            ({"chunk_size": 1000, "chunk_overlap": 600}, 422, None),  # over half
            ({"embedding_model": "gpt-6-sol"}, 422, "unknown_embedding_model"),
        ],
    )
    def test_invalid_settings_are_refused(
        self, client: TestClient, body: dict[str, Any], status: int, code: str | None
    ) -> None:
        response = client.post("/knowledge-bases", json={"name": "Docs"} | body)
        assert response.status_code == status
        if code:
            assert response.json()["detail"]["code"] == code

    def test_update(self, client: TestClient) -> None:
        kb = create(client)
        url = f"/knowledge-bases/{kb['knowledge_base_id']}"
        response = client.patch(url, json={"name": "Docs v2", "chunk_size": 400})
        assert response.status_code == 200
        updated = response.json()
        assert (updated["name"], updated["chunk_size"], updated["chunk_overlap"]) == (
            "Docs v2",
            400,
            150,
        )
        assert updated["updated_at"] > kb["updated_at"]
        # The stored overlap (150) counts: 250 / 2 < 150.
        refused = client.patch(url, json={"chunk_size": 250})
        assert refused.status_code == 422
        assert refused.json()["detail"]["code"] == "invalid_knowledge_base_settings"
        # The embedding model can change while it's empty…
        changed = client.patch(url, json={"embedding_model": "gemini-embedding-001"})
        assert changed.json()["embedding_model"] == "gemini-embedding-001"
        # …but not once it has documents (same model: fine).
        set_field(kb["knowledge_base_id"], document_count=3)
        locked = client.patch(url, json={"embedding_model": "text-embedding-3-small"})
        assert locked.status_code == 409
        assert locked.json()["detail"]["code"] == "embedding_model_locked"
        same = client.patch(url, json={"embedding_model": "gemini-embedding-001", "name": "Kept"})
        assert same.status_code == 200 and same.json()["name"] == "Kept"

    def test_other_users_knowledge_bases_look_missing(self, client: TestClient) -> None:
        kb = create(client)
        url = f"/knowledge-bases/{kb['knowledge_base_id']}"
        as_user("bob")
        assert client.get("/knowledge-bases").json() == []
        for response in (
            client.get(url),
            client.patch(url, json={"name": "Mine now"}),
            client.delete(url),
        ):
            assert response.status_code == 404
            assert response.json()["detail"]["code"] == "knowledge_base_not_found"
        as_user("alice")
        assert client.get(url).json()["name"] == "Product docs"

    def test_delete_removes_its_documents(self, client: TestClient) -> None:
        kb = create(client)
        kb_id = kb["knowledge_base_id"]
        get_db.cache_clear()

        async def add_documents() -> None:
            documents = get_db().collection(f"knowledge_bases/{kb_id}/documents")
            for i in range(3):
                await documents.document(f"d{i}").set({"name": f"doc {i}"})

        asyncio.run(add_documents())
        get_db.cache_clear()
        assert client.delete(f"/knowledge-bases/{kb_id}").status_code == 204
        assert client.get(f"/knowledge-bases/{kb_id}").status_code == 404

        async def remaining() -> int:
            documents = get_db().collection(f"knowledge_bases/{kb_id}/documents")
            return len([d async for d in documents.stream()])

        get_db.cache_clear()
        assert asyncio.run(remaining()) == 0
        get_db.cache_clear()

    def test_limit_per_user(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(knowledge_repo, "MAX_PER_USER", 2)
        create(client)
        create(client)
        response = client.post("/knowledge-bases", json={"name": "Third"})
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "too_many_knowledge_bases"

    def test_ids_are_checked(self, client: TestClient) -> None:
        assert client.get("/knowledge-bases/not%20an%20id").status_code == 422
