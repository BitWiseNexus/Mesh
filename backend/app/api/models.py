"""Models the editor offers (agents' chat models, knowledge bases' embedding models), depending on
which provider keys exist."""

import asyncio
from dataclasses import asdict

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.credentials import Repo
from app.core.auth import CurrentUser
from app.llm.embeddings import default_embedding_model, embedding_models
from app.llm.models import PROVIDER_ORDER, key_source, model_list, server_providers
from app.repositories.credentials import CredentialRepository

router = APIRouter(prefix="/models", tags=["models"])


class ProviderModels(BaseModel):
    id: str
    name: str
    #: `saved` (one of the caller's keys), `server`, `none`, or `not_needed` (mock models).
    key: str
    prefixes: list[str]
    models: list[str]
    recommended: list[str]


class EmbeddingModelOption(BaseModel):
    id: str
    label: str
    #: Same values as ProviderModels.key.
    key: str


class ModelList(BaseModel):
    providers: list[ProviderModels]
    #: What new agents should use.
    default: str
    embedding_models: list[EmbeddingModelOption]
    #: What new knowledge bases should use.
    default_embedding_model: str


async def saved_providers(repo: CredentialRepository, uid: str) -> list[str]:
    """LLM providers of the user's saved keys, newest key first."""
    saved: list[str] = []
    for credential in await repo.list(uid):  # newest first
        provider = credential.provider.value
        if provider in PROVIDER_ORDER and provider not in saved:
            saved.append(provider)
    return saved


@router.get("")
async def list_models(user: CurrentUser, repo: Repo) -> ModelList:
    """Each LLM provider's models (recommended first), where its key would come from, and the
    default model for new agents (the provider of the caller's newest saved key, else one the
    server has a key for, else `mock/echo` outside production); the same for the embedding
    models of knowledge bases. Mock models are listed only outside production."""
    saved = await saved_providers(repo, user.uid)
    # LiteLLM's model map: loaded in a thread (the first time can take seconds).
    providers, default = await asyncio.to_thread(model_list, saved)
    server = server_providers()
    embeddings = [
        EmbeddingModelOption(id=m.id, label=m.label, key=key_source(m.provider, saved, server))
        for m in embedding_models()
    ]
    return ModelList(
        providers=[ProviderModels(**asdict(p)) for p in providers],
        default=default,
        embedding_models=embeddings,
        default_embedding_model=default_embedding_model(saved, server),
    )
