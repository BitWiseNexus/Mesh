"""Embedding models for knowledge bases.

Every model produces vectors of the same size (`DIMENSIONS`): Firestore needs one vector index per
dimension, so a single size keeps one index on `kb_chunks.embedding` whatever model a knowledge
base uses. Both providers' models return shortened vectors on request (Matryoshka embeddings).

A knowledge base's model is fixed once it holds documents — its chunks must be compared with
queries embedded the same way.
"""

from dataclasses import dataclass

from app.core.config import get_settings

DIMENSIONS = 768


@dataclass(frozen=True)
class EmbeddingModel:
    id: str
    #: The credential provider whose key it needs (None: no key).
    provider: str | None
    label: str


EMBEDDING_MODELS = (
    EmbeddingModel("text-embedding-3-small", "openai", "OpenAI text-embedding-3-small"),
    EmbeddingModel("gemini-embedding-001", "gemini", "Gemini embedding 001"),
)
#: Deterministic, offline vectors (no meaning — similar texts aren't close) for trying knowledge
#: bases without a key and for tests; never offered in production.
MOCK_EMBEDDING = EmbeddingModel("mock/embedding", None, "Mock embeddings (testing)")


def embedding_models() -> list[EmbeddingModel]:
    """The models a knowledge base can use here."""
    mocks = [MOCK_EMBEDDING] if get_settings().mock_models_enabled else []
    return [*EMBEDDING_MODELS, *mocks]


def is_embedding_model(model_id: str) -> bool:
    return any(m.id == model_id for m in embedding_models())


def default_embedding_model(saved: list[str], server: set[str]) -> str:
    """For a new knowledge base: the provider of the user's newest saved key, else one the server
    has a key for (in model order), else the mock model (outside production), else the first."""
    for provider in [*saved, *(m.provider for m in EMBEDDING_MODELS if m.provider in server)]:
        for model in EMBEDDING_MODELS:
            if model.provider == provider:
                return model.id
    return MOCK_EMBEDDING.id if get_settings().mock_models_enabled else EMBEDDING_MODELS[0].id
