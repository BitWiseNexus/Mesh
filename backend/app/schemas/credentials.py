"""Saved API keys (`/credentials`). Values go in, never out: responses carry only a hint (the last
characters) so users can tell their keys apart."""

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field, field_validator


class CredentialProvider(StrEnum):
    """Must match CREDENTIAL_PROVIDERS in frontend/src/types/credentials.ts."""

    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GEMINI = "gemini"
    TAVILY = "tavily"
    #: Any HTTP API (used by the API Caller).
    HTTP = "http"


#: Providers whose keys agents use for LLM calls.
LLM_PROVIDERS = (CredentialProvider.OPENAI, CredentialProvider.ANTHROPIC, CredentialProvider.GEMINI)


def _clean_value(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("the key is empty")
    return value


class CredentialCreate(BaseModel):
    provider: CredentialProvider
    name: str = Field(min_length=1, max_length=100)
    value: str = Field(min_length=1, max_length=4096)

    _value = field_validator("value")(_clean_value)


class CredentialUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    value: str | None = Field(default=None, min_length=1, max_length=4096)

    @field_validator("value")
    @classmethod
    def _value(cls, value: str | None) -> str | None:
        return None if value is None else _clean_value(value)


class CredentialInfo(BaseModel):
    credential_id: str
    provider: CredentialProvider
    name: str
    #: The key's last characters, e.g. "…3f9a".
    hint: str
    created_at: datetime
    updated_at: datetime
