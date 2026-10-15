"""Models the editor offers for agents, depending on which provider keys exist."""

import asyncio
from dataclasses import asdict

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.credentials import Repo
from app.core.auth import CurrentUser
from app.llm.models import PROVIDER_ORDER, model_list

router = APIRouter(prefix="/models", tags=["models"])


class ProviderModels(BaseModel):
    id: str
    name: str
    #: `saved` (one of the caller's keys), `server`, `none`, or `not_needed` (mock models).
    key: str
    prefixes: list[str]
    models: list[str]
    recommended: list[str]


class ModelList(BaseModel):
    providers: list[ProviderModels]
    #: What new agents should use.
    default: str


@router.get("")
async def list_models(user: CurrentUser, repo: Repo) -> ModelList:
    """Each LLM provider's models (recommended first), where its key would come from, and the
    default model for new agents (the provider of the caller's newest saved key, else one the
    server has a key for, else `mock/echo` outside production). Mock models are listed only
    outside production."""
    saved: list[str] = []
    for credential in await repo.list(user.uid):  # newest first
        provider = credential.provider.value
        if provider in PROVIDER_ORDER and provider not in saved:
            saved.append(provider)
    # LiteLLM's model map: loaded in a thread (the first time can take seconds).
    providers, default = await asyncio.to_thread(model_list, saved)
    return ModelList(providers=[ProviderModels(**asdict(p)) for p in providers], default=default)
