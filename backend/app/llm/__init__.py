"""LLM access: one streaming chat interface over OpenAI / Anthropic / Gemini (via LiteLLM).

    async for text in stream_chat("gpt-4o", [{"role": "user", "content": "Hi"}]):
        ...

- Model names may be bare (`gpt-4o`, `claude-sonnet-5-5`, `gemini-2.5-pro`) or LiteLLM-qualified
  (`anthropic/claude-…`); bare names get their provider prefix (`qualify_model`). Bare Gemini names
  would otherwise go to Vertex AI; Mesh uses the Gemini API key.
- Provider keys come from the backend settings (`OPENAI_API_KEY`, …) until per-user credentials
  exist (Phase 4).
- `mock/echo` streams the last user message back (word by word) without calling a provider — for
  trying flows without keys, and for tests. Disabled when ENVIRONMENT=production.
- Failures raise `LlmError` with a message meant for the user.

LiteLLM takes seconds to import, so it's imported on first use (and warmed up at startup, see
`warm_up`), with its bundled model list instead of fetching one from the internet.
"""

import asyncio
import os
from collections.abc import AsyncIterator
from types import ModuleType
from typing import Any

from app.core.config import get_settings

Message = dict[str, str]

MOCK_PREFIX = "mock/"
MOCK_WORD_DELAY_SECONDS = 0.03

_PREFIXES = {
    "gpt-": "openai",
    "chatgpt-": "openai",
    "o1": "openai",
    "o3": "openai",
    "o4": "openai",
    "claude-": "anthropic",
    "gemini-": "gemini",
}
#: provider → (name, settings env var, env vars LiteLLM accepts)
_PROVIDERS = {
    "openai": ("OpenAI", "OPENAI_API_KEY", ("OPENAI_API_KEY",)),
    "anthropic": ("Anthropic", "ANTHROPIC_API_KEY", ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")),
    "gemini": ("Google Gemini", "GEMINI_API_KEY", ("GEMINI_API_KEY", "GOOGLE_API_KEY")),
}

_litellm: ModuleType | None = None


class LlmError(Exception):
    """An LLM call failed; the message is meant for the user."""


def qualify_model(model: str) -> str:
    model = model.strip()
    if "/" in model:
        return model
    for prefix, provider in _PREFIXES.items():
        if model.startswith(prefix):
            return f"{provider}/{model}"
    return model  # LiteLLM may still know it


def _load_litellm() -> ModuleType:
    global _litellm
    if _litellm is None:
        os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
        import litellm

        litellm.suppress_debug_info = True
        litellm.drop_params = True  # e.g. models that don't accept a temperature
        settings = get_settings()
        for env, key in (
            ("OPENAI_API_KEY", settings.openai_api_key),
            ("ANTHROPIC_API_KEY", settings.anthropic_api_key),
            ("GEMINI_API_KEY", settings.gemini_api_key),
        ):
            if key is not None:
                os.environ.setdefault(env, key.get_secret_value())
        _litellm = litellm
    return _litellm


def warm_up() -> None:
    """Imports LiteLLM ahead of the first run (call in a worker thread)."""
    _load_litellm()


async def stream_chat(
    model: str, messages: list[Message], *, temperature: float | None = None
) -> AsyncIterator[str]:
    """Streams the reply to `messages` as text chunks."""
    if model.strip().startswith(MOCK_PREFIX):
        async for chunk in _mock(model.strip(), messages):
            yield chunk
        return

    litellm = await asyncio.to_thread(_load_litellm)
    qualified = qualify_model(model)
    provider = _PROVIDERS.get(qualified.split("/", 1)[0])
    if provider and not any(os.environ.get(env) for env in provider[2]):
        # LiteLLM reports a missing key differently per provider; say it plainly instead.
        raise LlmError(
            f"No API key for {provider[0]}. Set {provider[1]} in backend/.env, or use the "
            "mock/echo model to try the flow without one."
        )
    try:
        response: Any = await litellm.acompletion(
            model=qualified,
            messages=messages,
            temperature=temperature,
            stream=True,
            timeout=get_settings().llm_timeout_seconds,
        )
        async for chunk in response:
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta:
                yield delta
    except Exception as exc:  # provider boundary: every failure becomes a user-facing message
        raise LlmError(_describe(exc, qualified, litellm)) from exc


def _describe(exc: Exception, model: str, litellm: ModuleType) -> str:
    provider = model.split("/", 1)[0] if "/" in model else ""
    name, env, _ = _PROVIDERS.get(provider, (provider or "the provider", "its API key", ()))
    errors = litellm.exceptions
    detail = str(exc).split("\n", 1)[0][:300]
    if isinstance(exc, errors.AuthenticationError):
        return (
            f"{name} rejected the request: no valid API key. Set {env} in backend/.env, or use "
            "the mock/echo model to try the flow without one."
        )
    if isinstance(exc, errors.NotFoundError):
        return f"{name} doesn't know the model “{model.split('/', 1)[-1]}”."
    if isinstance(exc, errors.RateLimitError):
        return f"{name} is rate-limiting requests (or the quota is used up). Try again later."
    if isinstance(exc, errors.Timeout):
        return f"{name} didn't answer in time."
    if isinstance(exc, errors.BadRequestError) and "LLM Provider NOT provided" in str(exc):
        return (
            f"Unknown model “{model}”. Use a name like gpt-4o, claude-sonnet-5-5 or "
            "gemini-2.5-flash, or prefix the provider (openai/…, anthropic/…, gemini/…)."
        )
    if isinstance(exc, errors.APIConnectionError):
        return f"Couldn't reach {name}: {detail}"
    return f"{name} returned an error: {detail}"


async def _mock(model: str, messages: list[Message]) -> AsyncIterator[str]:
    if not get_settings().mock_models_enabled:
        raise LlmError("Mock models aren't available on this server.")
    if model != "mock/echo":
        raise LlmError(f"Unknown mock model “{model}” (available: mock/echo).")
    last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    words = last_user.split(" ")
    for i, word in enumerate(words):
        await asyncio.sleep(MOCK_WORD_DELAY_SECONDS)
        yield word if i == len(words) - 1 else f"{word} "
