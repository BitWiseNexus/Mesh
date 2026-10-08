"""Saved API keys: encryption, the /credentials API (Firestore emulator), and their use in runs."""

import asyncio
import urllib.request
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

import app.core.crypto as crypto
from app.core.auth import AuthUser, get_current_user
from app.core.config import Settings
from app.core.firebase import get_db
from app.engine.executor import NodeError
from app.llm import ChatResult
from app.main import app
from app.repositories.credentials import CredentialRepository, hint_for
from app.services.credentials import UserSecrets
from tests.conftest import FIRESTORE_EMULATOR, requires_firestore_emulator
from tests.flows import node
from tests.test_executors import _run_agent
from tests.test_http_tool import mock_http
from tests.test_web_tools import KeySecrets, run_tool

CLEAR_URL = f"{FIRESTORE_EMULATOR}/emulator/v1/projects/demo-mesh/databases/(default)/documents"


def use_keys(monkeypatch: pytest.MonkeyPatch, keys: str | None, environment: str = "development"):
    settings = Settings(
        credentials_encryption_key=keys,
        environment=environment,
        use_firebase_emulators=environment != "production",
    )
    monkeypatch.setattr(crypto, "get_settings", lambda: settings)
    crypto.get_cipher.cache_clear()


@pytest.fixture(autouse=True)
def fresh_cipher() -> Iterator[None]:
    crypto.get_cipher.cache_clear()
    yield
    crypto.get_cipher.cache_clear()


class TestCrypto:
    def test_round_trip_and_rotation(self, monkeypatch: pytest.MonkeyPatch) -> None:
        old, new = Fernet.generate_key().decode(), Fernet.generate_key().decode()
        use_keys(monkeypatch, old)
        token = crypto.encrypt("sk-secret")
        assert "sk-secret" not in token and crypto.decrypt(token) == "sk-secret"
        use_keys(monkeypatch, f"{new}, {old}")  # rotated: old tokens still decrypt
        assert crypto.decrypt(token) == "sk-secret"
        use_keys(monkeypatch, new)
        with pytest.raises(crypto.DecryptionError):
            crypto.decrypt(token)

    def test_production_needs_a_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        use_keys(monkeypatch, None, environment="production")
        with pytest.raises(RuntimeError, match="must be set in production"):
            crypto.get_cipher()

    def test_development_falls_back_to_the_dev_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        use_keys(monkeypatch, None)
        assert crypto.decrypt(crypto.encrypt("x")) == "x"

    def test_invalid_keys_are_reported(self, monkeypatch: pytest.MonkeyPatch) -> None:
        use_keys(monkeypatch, "not-a-key")
        with pytest.raises(RuntimeError, match="CREDENTIALS_ENCRYPTION_KEY is invalid"):
            crypto.get_cipher()


def test_hints() -> None:
    assert hint_for("sk-abcdefgh1234") == "…1234"
    assert hint_for("short") == "…"  # too short to reveal any of it


# ── Secrets during runs (fake repository) ─────────────────────────────────


class FakeRepo:
    def __init__(self) -> None:
        self.keys = {"k1": ("openai", "sk-chosen"), "k2": ("http", "api-token")}
        self.lookups = 0

    async def secret(self, owner: str, credential_id: str) -> tuple[str, str] | None:
        self.lookups += 1
        return self.keys.get(credential_id)

    async def latest_secret(self, owner: str, provider: str) -> str | None:
        self.lookups += 1
        return {"anthropic": "sk-ant-latest"}.get(provider)


class TestUserSecrets:
    def get(self, secrets: UserSecrets, provider: str, credential_id: str | None = None):
        return asyncio.run(secrets.get(provider, credential_id))

    def test_lookup_and_cache(self) -> None:
        repo = FakeRepo()
        secrets = UserSecrets(repo, "u")  # type: ignore[arg-type]
        assert self.get(secrets, "anthropic") == "sk-ant-latest"
        assert self.get(secrets, "anthropic") == "sk-ant-latest"
        assert self.get(secrets, "openai") is None
        assert self.get(secrets, "openai", "k1") == "sk-chosen"
        assert repo.lookups == 3

    @pytest.mark.parametrize(
        ("provider", "credential_id", "message"),
        [
            ("openai", "gone", "no longer exists"),
            ("anthropic", "k1", "is for OpenAI, not Anthropic"),
        ],
    )
    def test_problems(self, provider: str, credential_id: str, message: str) -> None:
        with pytest.raises(NodeError, match=message):
            self.get(UserSecrets(FakeRepo(), "u"), provider, credential_id)  # type: ignore[arg-type]

    def test_any_provider_accepts_a_chosen_key(self) -> None:
        # e.g. an agent on a model whose provider Mesh doesn't recognise
        assert self.get(UserSecrets(FakeRepo(), "u"), "", "k1") == "sk-chosen"  # type: ignore[arg-type]


def test_agents_use_the_owners_key(monkeypatch: pytest.MonkeyPatch) -> None:
    keys: list[str | None] = []

    async def fake_complete(model, messages, *, api_key, on_text, **kwargs):
        keys.append(api_key)
        return ChatResult("ok")

    monkeypatch.setattr("app.nodes.executors.agent.complete", fake_complete)

    class Secrets(KeySecrets):
        async def get(self, provider: str, credential_id: str | None = None) -> str | None:
            return f"{provider}:{credential_id}"

    import tests.test_executors as executors_tests

    original = executors_tests.RunContext

    def with_secrets(*args: Any, **kwargs: Any):
        return original(*args, **kwargs, secrets=Secrets())

    monkeypatch.setattr(executors_tests, "RunContext", with_secrets)
    _run_agent("x", model="claude-sonnet-5-5")
    _run_agent("x", model="gpt-4o", credential_id="k1")
    _run_agent("x", model="mock/echo")
    assert keys == ["anthropic:None", "openai:k1", None]


def test_the_api_caller_sends_the_chosen_key(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = mock_http(monkeypatch, "app.net", lambda r: httpx.Response(200, json={}))
    secrets = KeySecrets(k2="api-token")
    run_tool(
        node(
            "api",
            "tool_http",
            url="https://api.example.com/a",
            headers={"authorization": "overridden"},
            credential_id="k2",
        ),
        {},
        secrets,
    )
    run_tool(
        node(
            "api",
            "tool_http",
            url="https://api.example.com/b",
            credential_id="k2",
            credential_header="X-API-Key",
        ),
        {},
        secrets,
    )
    assert seen[0].headers["Authorization"] == "Bearer api-token"
    assert seen[1].headers["X-API-Key"] == "api-token" and "Authorization" not in seen[1].headers


# ── API (Firestore emulator) ──────────────────────────────────────────────


@pytest.fixture
def client() -> Iterator[TestClient]:
    urllib.request.urlopen(urllib.request.Request(CLEAR_URL, method="DELETE"), timeout=5)
    get_db.cache_clear()
    with TestClient(app) as test_client:
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="alice")
        yield test_client
    app.dependency_overrides.clear()
    get_db.cache_clear()


def as_user(uid: str) -> None:
    app.dependency_overrides[get_current_user] = lambda: AuthUser(uid=uid)


@requires_firestore_emulator
class TestCredentialsApi:
    def create(self, client: TestClient, **body: Any) -> dict[str, Any]:
        response = client.post(
            "/credentials",
            json={"provider": "openai", "name": "Work", "value": "sk-test-abcd1234"} | body,
        )
        assert response.status_code == 201, response.text
        return response.json()

    def test_values_go_in_but_never_come_out(self, client: TestClient) -> None:
        created = self.create(client)
        assert created["hint"] == "…1234" and created["provider"] == "openai"
        assert "value" not in created and "secret" not in created
        listed = client.get("/credentials").json()
        assert listed == [created]
        assert "sk-test" not in client.get("/credentials").text

    def test_stored_encrypted_and_usable_by_runs(self, client: TestClient) -> None:
        created = self.create(client, value="  sk-test-abcd1234  ")  # trimmed
        repo = CredentialRepository(get_db())
        raw = client.portal.call(  # type: ignore[union-attr]
            lambda: repo._collection.document(created["credential_id"]).get()
        ).to_dict()
        assert "sk-test" not in raw["secret"] and raw["owner_uid"] == "alice"
        secrets = UserSecrets(repo, "alice")
        portal = client.portal  # type: ignore[union-attr]
        assert portal.call(lambda: secrets.get("openai")) == "sk-test-abcd1234"
        assert portal.call(lambda: secrets.get("openai", created["credential_id"])) == (
            "sk-test-abcd1234"
        )
        assert portal.call(lambda: UserSecrets(repo, "bob").get("openai")) is None

    def test_rename_replace_and_delete(self, client: TestClient) -> None:
        created = self.create(client)
        path = f"/credentials/{created['credential_id']}"
        renamed = client.patch(path, json={"name": "Personal"}).json()
        assert renamed["name"] == "Personal" and renamed["hint"] == "…1234"
        replaced = client.patch(path, json={"value": "sk-new-key-9999"}).json()
        assert replaced["hint"] == "…9999" and replaced["updated_at"] >= created["updated_at"]
        assert client.delete(path).status_code == 204
        assert client.get("/credentials").json() == []
        assert client.delete(path).json()["detail"]["code"] == "credential_not_found"

    def test_others_keys_are_invisible(self, client: TestClient) -> None:
        created = self.create(client)
        as_user("mallory")
        assert client.get("/credentials").json() == []
        path = f"/credentials/{created['credential_id']}"
        assert client.patch(path, json={"name": "x"}).status_code == 404
        assert client.delete(path).status_code == 404

    @pytest.mark.parametrize(
        "body",
        [
            {"provider": "aws", "name": "x", "value": "y"},
            {"provider": "openai", "name": "", "value": "y"},
            {"provider": "openai", "name": "x", "value": "   "},
            {"provider": "openai", "name": "x", "value": "y" * 5000},
        ],
    )
    def test_invalid_bodies(self, client: TestClient, body: dict[str, Any]) -> None:
        assert client.post("/credentials", json=body).status_code == 422

    def test_limit_per_user(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("app.repositories.credentials.MAX_PER_USER", 2)
        self.create(client)
        self.create(client, name="Second")
        response = client.post(
            "/credentials", json={"provider": "tavily", "name": "Third", "value": "tvly-123456"}
        )
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "too_many_credentials"

    def test_requires_authentication(self, client: TestClient) -> None:
        app.dependency_overrides.clear()
        assert client.get("/credentials").status_code == 401
