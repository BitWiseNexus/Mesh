"""The models offered to agents (app/llm/models.py, GET /models)."""

import urllib.request
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

import app.llm.models as models
from app.core.auth import AuthUser, get_current_user
from app.core.config import Settings
from app.core.firebase import get_db
from app.llm import _load_litellm, qualify_model
from app.main import app
from app.nodes.catalog import CATALOG
from app.schemas.node_types import NodeType
from tests.conftest import FIRESTORE_EMULATOR, requires_firestore_emulator

CLEAR_URL = f"{FIRESTORE_EMULATOR}/emulator/v1/projects/demo-mesh/databases/(default)/documents"


@pytest.mark.parametrize(
    ("provider", "model"), [(p, m) for p, names in models.RECOMMENDED.items() for m in names]
)
def test_recommended_models_are_known_to_litellm(provider: str, model: str) -> None:
    """Guards against typos and models LiteLLM no longer knows (check after upgrading it)."""
    qualified = qualify_model(model)
    assert qualified == f"{provider}/{model}"  # Mesh routes the bare name to this provider
    info = _load_litellm().model_cost.get(qualified) or _load_litellm().model_cost.get(model)
    assert info, f"LiteLLM doesn't know {model}"
    assert info["mode"] == "chat" and info.get("supports_function_calling")


def test_known_models_leave_out_snapshots_and_previews() -> None:
    for provider in models.PROVIDER_ORDER:
        names = models.known_models(provider)
        assert names, provider
        assert all(qualify_model(n) == f"{provider}/{n}" for n in names)
        assert not [n for n in names if "preview" in n or "-20" in n]  # no dated snapshots
    assert "gpt-4o-2024-08-06" not in models.known_models("openai")


def test_the_agents_catalog_default_is_the_fallback_model() -> None:
    agent = CATALOG[NodeType.AGENT_NODE]
    assert agent.default_data["model"] == models.FALLBACK_MODEL
    model_field = next(f for f in agent.fields if f.key == "model")
    assert model_field.kind == "model" and model_field.required


@pytest.mark.parametrize(
    ("saved", "server", "mocks", "expected"),
    [
        (["anthropic", "openai"], {"gemini"}, True, "claude-sonnet-5"),  # newest saved key wins
        ([], {"gemini", "openai"}, True, "gpt-6-sol"),  # server keys: fixed order
        ([], {"gemini"}, False, "gemini-3.8-flash"),
        ([], set(), True, "mock/echo"),  # nothing configured: the mock model, outside production
        ([], set(), False, models.FALLBACK_MODEL),
    ],
)
def test_default_model(saved: list[str], server: set[str], mocks: bool, expected: str) -> None:
    assert models.choose_default(saved, server, mocks) == expected


def use(monkeypatch: pytest.MonkeyPatch, *, server: set[str], production: bool = False) -> None:
    settings = Settings(
        environment="production" if production else "development",
        use_firebase_emulators=not production,
    )
    monkeypatch.setattr(models, "get_settings", lambda: settings)
    monkeypatch.setattr(models, "server_has_key", lambda provider: provider in server)


def test_model_list(monkeypatch: pytest.MonkeyPatch) -> None:
    use(monkeypatch, server={"gemini"})
    providers, default = models.model_list(["openai"])
    by_id = {p.id: p for p in providers}
    assert [p.id for p in providers] == ["openai", "anthropic", "gemini", "mock"]
    assert [by_id[p].key for p in ("openai", "anthropic", "gemini", "mock")] == [
        "saved",
        "none",
        "server",
        "not_needed",
    ]
    openai = by_id["openai"]
    assert openai.models[: len(openai.recommended)] == openai.recommended  # recommended first
    assert len(set(openai.models)) == len(openai.models)
    assert "gpt-" in openai.prefixes and by_id["anthropic"].prefixes == ["claude-"]
    assert by_id["mock"].models == ["mock/echo", "mock/tools"]
    assert by_id["mock"].recommended == []
    assert default == "gpt-6-sol"

    use(monkeypatch, server=set(), production=True)
    providers, default = models.model_list([])
    assert "mock" not in [p.id for p in providers]  # never offered in production
    assert default == models.FALLBACK_MODEL


def test_server_keys_come_from_settings_or_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for env in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        monkeypatch.delenv(env, raising=False)
    monkeypatch.setattr(models, "get_settings", lambda: Settings(openai_api_key="sk-x"))
    assert models.server_has_key("openai")
    assert not models.server_has_key("anthropic")
    monkeypatch.setattr(models, "get_settings", lambda: Settings(openai_api_key=""))
    assert not models.server_has_key("openai")  # OPENAI_API_KEY= (empty) is no key
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "t")
    assert models.server_has_key("anthropic")


# ── API (Firestore emulator: the caller's saved keys) ─────────────────────


@pytest.fixture
def client() -> Iterator[TestClient]:
    urllib.request.urlopen(urllib.request.Request(CLEAR_URL, method="DELETE"), timeout=5)
    get_db.cache_clear()
    with TestClient(app) as test_client:
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="alice")
        yield test_client
    app.dependency_overrides.clear()
    get_db.cache_clear()


@requires_firestore_emulator
def test_models_api_follows_the_callers_saved_keys(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    use(monkeypatch, server={"openai"})
    body = client.get("/models").json()
    assert body["default"] == "gpt-6-sol"
    assert {p["id"]: p["key"] for p in body["providers"]}["anthropic"] == "none"

    for provider in ("tavily", "anthropic"):  # newest last; tavily isn't an LLM provider
        response = client.post(
            "/credentials", json={"provider": provider, "name": "Key", "value": "sk-1234567890"}
        )
        assert response.status_code == 201
    body = client.get("/models").json()
    assert body["default"] == "claude-sonnet-5"
    keys = {p["id"]: p["key"] for p in body["providers"]}
    assert keys == {
        "openai": "server",
        "anthropic": "saved",
        "gemini": "none",
        "mock": "not_needed",
    }

    app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="bob")  # not Alice's keys
    assert client.get("/models").json()["default"] == "gpt-6-sol"


def test_models_api_needs_sign_in() -> None:
    with TestClient(app) as anonymous:
        assert anonymous.get("/models").status_code == 401
