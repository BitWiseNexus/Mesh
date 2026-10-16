"""The models the editor offers agents (`GET /models`).

Per provider: a short, ordered list of recommended models — its default first (a good balance of
quality and price), then the most capable, then fast/cheap ones — and every other chat model with
tool calling that LiteLLM's bundled model map knows (so the list grows with LiteLLM upgrades).
Users can still type any model name LiteLLM accepts.
"""

import os
import re
from dataclasses import dataclass
from datetime import date
from functools import lru_cache

from app.core.config import get_settings
from app.llm import _PREFIXES, _PROVIDERS, MOCK_MODELS, _load_litellm, qualify_model

#: Every name must be in LiteLLM's model map with tool calling (tests/test_models.py); revisit when
#: upgrading LiteLLM.
RECOMMENDED: dict[str, list[str]] = {
    "openai": ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna"],
    "anthropic": ["claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1", "claude-haiku-4-5"],
    "gemini": ["gemini-3.8-flash", "gemini-2.5-pro", "gemini-3.5-flash-lite"],
}
#: Ties between providers with a server key are broken in this order.
PROVIDER_ORDER = ("openai", "anthropic", "gemini")
#: The agent's catalog default: used when no provider has a key and mock models are off.
FALLBACK_MODEL = RECOMMENDED["openai"][0]
MOCK_DEFAULT = "mock/echo"

# Snapshots, previews and special-purpose variants aren't worth offering in a list.
_HIDDEN = re.compile(
    r"\d{4}-\d{2}-\d{2}|\d{8}|-\d{4}$|preview|exp|latest|audio|realtime|search|transcribe|tts"
    r"|image|computer|customtools|gemma|lyria|learnlm|robotics|thinking|live|[:@]"
)


@dataclass(frozen=True)
class ProviderModels:
    id: str
    name: str
    #: Where the key would come from: the user's saved keys, the server, nowhere — or not needed.
    key: str
    #: Bare model-name prefixes that select this provider (e.g. `gpt-`), for the editor's hints.
    prefixes: list[str]
    #: Recommended first, then the rest (newest-looking first).
    models: list[str]
    recommended: list[str]


def _natural_key(name: str) -> list[int | str]:
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", name)]


@lru_cache
def known_models(provider: str) -> tuple[str, ...]:
    """Chat models with tool calling LiteLLM knows for `provider`, as bare names (call after
    LiteLLM has loaded — it's imported lazily)."""
    litellm = _load_litellm()
    today = date.today().isoformat()
    names: set[str] = set()
    for key, info in litellm.model_cost.items():
        if info.get("litellm_provider") != provider or info.get("mode") != "chat":
            continue
        if not info.get("supports_function_calling"):
            continue
        if (info.get("deprecation_date") or "9999") <= today:
            continue
        name = key.removeprefix(f"{provider}/")
        if "/" in name or _HIDDEN.search(name):
            continue
        if qualify_model(name) != f"{provider}/{name}":
            continue  # a bare name Mesh wouldn't send to this provider
        names.add(name)
    return tuple(sorted(names, key=_natural_key, reverse=True))


def server_has_key(provider: str) -> bool:
    """Whether the server itself has an API key for `provider` (backend/.env or environment)."""
    _, setting, env_names = _PROVIDERS[provider]
    configured = getattr(get_settings(), setting.lower(), None)  # SecretStr | None
    return bool(configured and configured.get_secret_value()) or any(
        os.environ.get(env) for env in env_names
    )


def server_providers() -> set[str]:
    """The LLM providers the server has a key for."""
    return {p for p in PROVIDER_ORDER if server_has_key(p)}


def key_source(provider: str | None, saved: list[str], server: set[str]) -> str:
    """Where a call to `provider` would get its key: `saved` (one of the user's keys), `server`,
    `none` — or `not_needed` (no provider: mock models)."""
    if provider is None:
        return "not_needed"
    return "saved" if provider in saved else "server" if provider in server else "none"


def choose_default(saved: list[str], server: set[str], mocks: bool) -> str:
    """The model new agents get: the provider of the user's newest saved key, else one the server
    has a key for, else the mock model (when allowed), else the catalog default."""
    for provider in [*saved, *(p for p in PROVIDER_ORDER if p in server)]:
        if provider in RECOMMENDED:
            return RECOMMENDED[provider][0]
    return MOCK_DEFAULT if mocks else FALLBACK_MODEL


def model_list(saved: list[str]) -> tuple[list[ProviderModels], str]:
    """Every provider's models and where its key comes from; `saved` = providers of the user's
    saved keys, newest first. Returns (providers, default model)."""
    settings = get_settings()
    server = server_providers()
    providers: list[ProviderModels] = []
    for provider in PROVIDER_ORDER:
        recommended = RECOMMENDED[provider]
        rest = [m for m in known_models(provider) if m not in recommended]
        providers.append(
            ProviderModels(
                id=provider,
                name=_PROVIDERS[provider][0],
                key=key_source(provider, saved, server),
                prefixes=[prefix for prefix, p in _PREFIXES.items() if p == provider],
                models=[*recommended, *rest],
                recommended=recommended,
            )
        )
    if settings.mock_models_enabled:
        providers.append(
            ProviderModels(
                id="mock",
                name="Testing (no API key)",
                key="not_needed",
                prefixes=["mock/"],
                models=list(MOCK_MODELS),
                recommended=[],  # test models: nothing to recommend
            )
        )
    return providers, choose_default(saved, server, settings.mock_models_enabled)
