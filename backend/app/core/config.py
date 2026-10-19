from functools import lru_cache
from typing import Self

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Mesh"
    environment: str = "development"
    cors_origins: list[str] = ["http://localhost:3000"]

    # Firebase. "demo-*" project IDs only work against the emulators (no real project needed).
    firebase_project_id: str = "demo-mesh"
    firebase_storage_bucket: str | None = None  # defaults to "<project_id>.appspot.com"
    firebase_credentials_path: str | None = None  # service-account JSON; unused with emulators
    use_firebase_emulators: bool = True
    firestore_emulator_host: str = "127.0.0.1:8080"
    firebase_auth_emulator_host: str = "127.0.0.1:9099"
    firebase_storage_emulator_host: str = "127.0.0.1:9199"

    # Auth. Revocation checks cost an extra Firebase call per request; enable for sensitive setups.
    auth_check_revoked: bool = False
    # Tolerate small clock differences between this server and Google when checking token times.
    auth_clock_skew_seconds: int = Field(default=10, ge=0, le=60)

    #: API requests that take longer get 503 `server_timeout` (event streams are exempt).
    request_timeout_seconds: float = Field(default=20, gt=0)

    # Runs. Live runs (tasks + event streams) are held in this process: run a single backend
    # instance until runs move to a worker queue.
    run_timeout_seconds: int = Field(default=600, ge=1)
    max_active_runs_per_user: int = Field(default=5, ge=1)
    #: How long a finished run's events stay available for (re)connecting streams.
    run_events_retention_seconds: int = Field(default=300, ge=0)

    # Webhook triggers (POST /hooks/{flow_id}/{node_id}).
    webhook_max_body_bytes: int = Field(default=1_000_000, ge=1)
    #: Requests each webhook accepts per minute; more get 429 `rate_limited`.
    webhook_requests_per_minute: int = Field(default=60, ge=1)
    #: How long a caller waits for the flow's HTTP Response node before getting 202 + the run id.
    webhook_response_timeout_seconds: float = Field(default=60, gt=0)

    # Schedule triggers: checked once a minute by an in-process scheduler (one backend instance
    # is enough; several are safe — each due time is claimed once). Off → schedules never fire.
    scheduler_enabled: bool = True
    #: A run due longer ago than this (the server wasn't running) is skipped, not caught up.
    schedule_grace_seconds: int = Field(default=300, ge=0)

    # LLM providers (read by LiteLLM). Per-user keys arrive with the credentials store (Phase 4).
    openai_api_key: SecretStr | None = None
    anthropic_api_key: SecretStr | None = None
    gemini_api_key: SecretStr | None = None
    # Web search (the Web Search tool falls back to DuckDuckGo without one).
    tavily_api_key: SecretStr | None = None
    # Email (Send Email node, via Resend). Users can save their own key; the sender address must
    # be on a domain verified in that Resend account. Resend's test sender only delivers to the
    # account owner's own address.
    resend_api_key: SecretStr | None = None
    email_from: str = "Mesh <onboarding@resend.dev>"
    llm_timeout_seconds: int = Field(default=120, ge=1)
    #: One tool call of an agent (an agent used as a tool counts as one call).
    tool_timeout_seconds: int = Field(default=120, ge=1)

    # Encryption of users' saved API keys: Fernet keys, comma-separated — the first encrypts, all
    # decrypt (rotation: put the new key first, re-save, then drop the old one). Required in
    # production; development falls back to a fixed, public dev key.
    credentials_encryption_key: SecretStr | None = None

    # Outbound requests of tools (API Caller, Web Scraper) to private / local addresses. None →
    # allowed except in production (lets you call APIs on your machine while developing).
    outbound_allow_private_networks: bool | None = None

    @property
    def allow_private_networks(self) -> bool:
        if self.outbound_allow_private_networks is not None:
            return self.outbound_allow_private_networks
        return self.environment != "production"

    @property
    def mock_models_enabled(self) -> bool:
        """`mock/*` models (canned replies, no provider) for local development and tests."""
        return self.environment != "production"

    @model_validator(mode="after")
    def _no_emulators_in_production(self) -> Self:
        # Emulator tokens are unsigned: accepting them in production would let anyone sign in.
        if self.environment == "production" and self.use_firebase_emulators:
            raise ValueError("USE_FIREBASE_EMULATORS must be false when ENVIRONMENT=production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
