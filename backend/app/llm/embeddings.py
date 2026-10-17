"""Embedding models for knowledge bases.

Every model produces vectors of the same size (`DIMENSIONS`): Firestore needs one vector index per
dimension, so a single size keeps one index on `kb_chunks.embedding` whatever model a knowledge
base uses. Both providers' models return shortened vectors on request (Matryoshka embeddings).

A knowledge base's model is fixed once it holds documents — its chunks must be compared with
queries embedded the same way.

    vectors = await embed("text-embedding-3-small", ["chunk one", "chunk two"], api_key=key)

Vectors are L2-normalised (Gemini's shortened vectors aren't); failures raise LlmError with a
message meant for the user.
"""

import asyncio
import hashlib
import math
import os
import re
from dataclasses import dataclass
from typing import Any, Literal

from app.core.config import get_settings
from app.llm import _PROVIDERS, LlmError, _describe, _load_litellm

DIMENSIONS = 768
#: Texts per embedding request.
BATCH_SIZE = 64


@dataclass(frozen=True)
class EmbeddingModel:
    id: str
    #: The credential provider whose key it needs (None: no key).
    provider: str | None
    label: str
    #: The name LiteLLM routes by.
    litellm_model: str = ""


EMBEDDING_MODELS = (
    EmbeddingModel(
        "text-embedding-3-small",
        "openai",
        "OpenAI text-embedding-3-small",
        "openai/text-embedding-3-small",
    ),
    EmbeddingModel(
        "gemini-embedding-001", "gemini", "Gemini embedding 001", "gemini/gemini-embedding-001"
    ),
)
#: Offline, deterministic vectors for trying knowledge bases without a key and for tests — a hashed
#: bag of words, so texts sharing words are close (keyword overlap, no meaning). Never offered in
#: production.
MOCK_EMBEDDING = EmbeddingModel("mock/embedding", None, "Mock embeddings (testing)")


def embedding_models() -> list[EmbeddingModel]:
    """The models a knowledge base can use here."""
    mocks = [MOCK_EMBEDDING] if get_settings().mock_models_enabled else []
    return [*EMBEDDING_MODELS, *mocks]


def is_embedding_model(model_id: str) -> bool:
    return any(m.id == model_id for m in embedding_models())


def embedding_model(model_id: str) -> EmbeddingModel | None:
    """The model with this id (offered here or not)."""
    return next((m for m in (*EMBEDDING_MODELS, MOCK_EMBEDDING) if m.id == model_id), None)


def default_embedding_model(saved: list[str], server: set[str]) -> str:
    """For a new knowledge base: the provider of the user's newest saved key, else one the server
    has a key for (in model order), else the mock model (outside production), else the first."""
    for provider in [*saved, *(m.provider for m in EMBEDDING_MODELS if m.provider in server)]:
        for model in EMBEDDING_MODELS:
            if model.provider == provider:
                return model.id
    return MOCK_EMBEDDING.id if get_settings().mock_models_enabled else EMBEDDING_MODELS[0].id


_WORD = re.compile(r"\w+")


def _normalised(vector: list[float]) -> list[float]:
    length = math.sqrt(sum(v * v for v in vector))
    return [v / length for v in vector] if length else vector


def mock_vector(text: str) -> list[float]:
    """Hashed bag of words (lower-cased), L2-normalised; an empty text gets a fixed vector."""
    vector = [0.0] * DIMENSIONS
    for word in _WORD.findall(text.lower()) or ["<empty>"]:
        digest = hashlib.blake2b(word.encode(), digest_size=8).digest()
        slot = int.from_bytes(digest[:4], "little") % DIMENSIONS
        vector[slot] += 1.0 if digest[4] & 1 else -1.0
    return _normalised(vector)


async def embed(
    model_id: str,
    texts: list[str],
    *,
    api_key: str | None = None,
    task: Literal["document", "query"] = "document",
) -> list[list[float]]:
    """One `DIMENSIONS`-long vector per text. `task`: chunks being stored, or a search query
    (Gemini embeds them differently)."""
    if model_id == MOCK_EMBEDDING.id:
        if not get_settings().mock_models_enabled:
            raise LlmError("Mock models aren't available on this server.")
        return [mock_vector(t) for t in texts]
    model = embedding_model(model_id)
    if model is None or model.provider is None:
        raise LlmError(f"Unknown embedding model “{model_id}”.")
    name, setting, env_names = _PROVIDERS[model.provider]
    litellm = await asyncio.to_thread(_load_litellm)  # also puts the server's keys in the env
    if not api_key and not any(os.environ.get(env) for env in env_names):
        raise LlmError(
            f"No API key for {name}. Add one under API keys, or set {setting} in backend/.env."
        )
    options: dict[str, Any] = {"dimensions": DIMENSIONS}
    if model.provider == "gemini":
        options["task_type"] = "RETRIEVAL_QUERY" if task == "query" else "RETRIEVAL_DOCUMENT"
    if api_key:
        options["api_key"] = api_key
    vectors: list[list[float]] = []
    for start in range(0, len(texts), BATCH_SIZE):
        batch = texts[start : start + BATCH_SIZE]
        try:
            response: Any = await litellm.aembedding(
                model=model.litellm_model,
                input=batch,
                timeout=get_settings().llm_timeout_seconds,
                **options,
            )
        except Exception as exc:  # provider boundary: every failure becomes a user-facing message
            raise LlmError(_describe(exc, model.litellm_model, litellm)) from exc
        data = sorted(response.data, key=lambda d: d["index"])
        if len(data) != len(batch) or any(len(d["embedding"]) != DIMENSIONS for d in data):
            raise LlmError(f"{name} returned unexpected embeddings.")
        vectors.extend(_normalised(list(d["embedding"])) for d in data)
    return vectors
