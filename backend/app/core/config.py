from functools import lru_cache
from typing import Self

from pydantic import Field, model_validator
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

    @model_validator(mode="after")
    def _no_emulators_in_production(self) -> Self:
        # Emulator tokens are unsigned: accepting them in production would let anyone sign in.
        if self.environment == "production" and self.use_firebase_emulators:
            raise ValueError("USE_FIREBASE_EMULATORS must be false when ENVIRONMENT=production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
