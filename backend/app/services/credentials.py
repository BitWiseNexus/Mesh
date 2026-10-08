"""A run owner's saved API keys, as executors see them (`ctx.run.secrets`)."""

from app.core.crypto import DecryptionError
from app.engine.executor import NodeError
from app.repositories.credentials import CredentialRepository
from app.schemas.credentials import CredentialProvider

_LABELS = {
    CredentialProvider.OPENAI: "OpenAI",
    CredentialProvider.ANTHROPIC: "Anthropic",
    CredentialProvider.GEMINI: "Google Gemini",
    CredentialProvider.TAVILY: "Tavily",
    CredentialProvider.HTTP: "HTTP API",
}


def provider_label(provider: str) -> str:
    try:
        return _LABELS[CredentialProvider(provider)]
    except ValueError:
        return provider


class UserSecrets:
    """Looks keys up on first use and remembers them for the rest of the run."""

    def __init__(self, repository: CredentialRepository, owner_uid: str) -> None:
        self._repository = repository
        self._owner_uid = owner_uid
        self._cache: dict[tuple[str, str | None], str | None] = {}

    async def get(self, provider: str, credential_id: str | None = None) -> str | None:
        key = (provider, credential_id)
        if key not in self._cache:
            self._cache[key] = await self._load(provider, credential_id)
        return self._cache[key]

    async def _load(self, provider: str, credential_id: str | None) -> str | None:
        try:
            if not credential_id:
                return await self._repository.latest_secret(self._owner_uid, provider)
            found = await self._repository.secret(self._owner_uid, credential_id)
        except DecryptionError as exc:
            raise NodeError(
                "A saved API key can't be decrypted (the server's encryption key changed). "
                "Save the key again under API keys."
            ) from exc
        if found is None:
            raise NodeError("The selected API key no longer exists. Choose another one.")
        stored_provider, secret = found
        if provider and stored_provider != provider:
            raise NodeError(
                f"The selected API key is for {provider_label(stored_provider)}, not "
                f"{provider_label(provider)}."
            )
        return secret
