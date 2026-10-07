from functools import lru_cache

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


@lru_cache
def get_settings() -> Settings:
    return Settings()
