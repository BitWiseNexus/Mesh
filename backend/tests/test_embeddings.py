"""Embedding calls (app/llm/embeddings.py) with a fake LiteLLM, and the mock embeddings."""

import asyncio
import math
from types import SimpleNamespace
from typing import Any

import pytest

import app.llm.embeddings as embeddings
from app.core.config import Settings
from app.llm import LlmError

KEY_ENV = ("OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY")


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def test_mock_vectors_reflect_shared_words() -> None:
    a = embeddings.mock_vector("How do I reset my password?")
    assert len(a) == embeddings.DIMENSIONS
    assert math.isclose(math.sqrt(sum(v * v for v in a)), 1.0)
    assert a == embeddings.mock_vector("how do i RESET my password")  # deterministic, lower-cased
    related = embeddings.mock_vector("Reset your password from the login page.")
    unrelated = embeddings.mock_vector("Invoices are sent on the first of the month.")
    assert cosine(a, related) > cosine(a, unrelated)
    assert len(embeddings.mock_vector("")) == embeddings.DIMENSIONS


class FakeLiteLLM:
    def __init__(self, dims: int = embeddings.DIMENSIONS, error: Exception | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.dims = dims
        self.error = error
        self.exceptions = __import__("litellm").exceptions

    async def aembedding(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        # Out of order on purpose: results are matched by index. Unnormalised vectors.
        data = [
            {"index": i, "embedding": [float(i + 1)] + [0.0] * (self.dims - 1)}
            for i in range(len(kwargs["input"]))
        ]
        return SimpleNamespace(data=list(reversed(data)))


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeLiteLLM:
    fake = FakeLiteLLM()
    monkeypatch.setattr(embeddings, "_load_litellm", lambda: fake)
    for env in KEY_ENV:
        monkeypatch.delenv(env, raising=False)
    return fake


def run(*args: Any, **kwargs: Any) -> list[list[float]]:
    return asyncio.run(embeddings.embed(*args, **kwargs))


def test_openai_embeddings_in_batches(fake: FakeLiteLLM, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(embeddings, "BATCH_SIZE", 2)
    vectors = run("text-embedding-3-small", ["a", "b", "c"], api_key="sk-user")
    assert [len(c["input"]) for c in fake.calls] == [2, 1]
    call = fake.calls[0]
    assert call["model"] == "openai/text-embedding-3-small"
    assert call["dimensions"] == 768 and call["api_key"] == "sk-user"
    assert "task_type" not in call
    assert [v[0] for v in vectors] == [1.0, 1.0, 1.0]  # in input order, normalised


def test_gemini_gets_the_retrieval_task(fake: FakeLiteLLM, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "server-key")
    run("gemini-embedding-001", ["chunk"])
    run("gemini-embedding-001", ["question"], task="query")
    assert [c["task_type"] for c in fake.calls] == ["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"]
    assert fake.calls[0]["model"] == "gemini/gemini-embedding-001"
    assert "api_key" not in fake.calls[0]  # the server's key, from the environment


def test_missing_keys_and_unknown_models_are_explained(fake: FakeLiteLLM) -> None:
    with pytest.raises(LlmError, match="No API key for OpenAI"):
        run("text-embedding-3-small", ["a"])
    with pytest.raises(LlmError, match="Unknown embedding model"):
        run("gpt-6-sol", ["a"])
    assert fake.calls == []


def test_provider_failures_and_bad_answers_become_messages(monkeypatch: pytest.MonkeyPatch) -> None:
    errors = __import__("litellm").exceptions
    failing = FakeLiteLLM(error=errors.AuthenticationError("bad key", "openai", "x"))
    monkeypatch.setattr(embeddings, "_load_litellm", lambda: failing)
    with pytest.raises(LlmError, match="OpenAI rejected the request"):
        run("text-embedding-3-small", ["a"], api_key="sk-bad")
    monkeypatch.setattr(embeddings, "_load_litellm", lambda: FakeLiteLLM(dims=1536))
    with pytest.raises(LlmError, match="unexpected embeddings"):
        run("text-embedding-3-small", ["a"], api_key="sk")


def test_the_mock_model_is_refused_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    production = Settings(environment="production", use_firebase_emulators=False)
    monkeypatch.setattr(embeddings, "get_settings", lambda: production)
    with pytest.raises(LlmError, match="aren't available"):
        run("mock/embedding", ["a"])
