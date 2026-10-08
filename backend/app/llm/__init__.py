"""LLM access: one streaming chat interface over OpenAI / Anthropic / Gemini (via LiteLLM).

    result = await complete("gpt-4o", messages, tools=[...], on_text=print)
    result.text, result.tool_calls

- Model names may be bare (`gpt-4o`, `claude-sonnet-5-5`, `gemini-2.5-pro`) or LiteLLM-qualified
  (`anthropic/claude-…`); bare names get their provider prefix (`qualify_model`). Bare Gemini names
  would otherwise go to Vertex AI; Mesh uses the Gemini API key.
- The API key is the caller's (`api_key`, e.g. the user's saved credential) or the server's
  (`OPENAI_API_KEY`, … in the backend settings).
- Tools use the OpenAI function format; LiteLLM converts them for each provider. Streamed tool
  call fragments are assembled into `ToolCall`s.
- Mock models (no provider; disabled when ENVIRONMENT=production), for trying flows without keys
  and for tests: `mock/echo` streams the last user message back word by word; `mock/tools` calls
  every tool it's offered once (each argument = the user message), then reports the results.
- Failures raise `LlmError` with a message meant for the user.

LiteLLM takes seconds to import, so it's imported on first use (and warmed up at startup, see
`warm_up`), with its bundled model list instead of fetching one from the internet.
"""

import asyncio
import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from types import ModuleType
from typing import Any

from app.core.config import get_settings

Message = dict[str, Any]
Tool = dict[str, Any]

MOCK_PREFIX = "mock/"
MOCK_MODELS = ("mock/echo", "mock/tools")
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


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    #: JSON text, as the model wrote it (may be invalid).
    arguments: str


@dataclass
class ChatResult:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)

    def assistant_message(self) -> Message:
        """This reply as a message for the next round of the conversation."""
        message: Message = {"role": "assistant", "content": self.text or None}
        if self.tool_calls:
            message["tool_calls"] = [
                {
                    "id": c.id,
                    "type": "function",
                    "function": {"name": c.name, "arguments": c.arguments},
                }
                for c in self.tool_calls
            ]
        return message


def qualify_model(model: str) -> str:
    model = model.strip()
    if "/" in model:
        return model
    for prefix, provider in _PREFIXES.items():
        if model.startswith(prefix):
            return f"{provider}/{model}"
    return model  # LiteLLM may still know it


def provider_of(model: str) -> str | None:
    """`openai` / `anthropic` / `gemini` for models Mesh knows the provider of, else None."""
    qualified = qualify_model(model)
    provider = qualified.split("/", 1)[0] if "/" in qualified else ""
    return provider if provider in _PROVIDERS else None


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


async def complete(
    model: str,
    messages: list[Message],
    *,
    tools: list[Tool] | None = None,
    tool_choice: str | None = None,
    temperature: float | None = None,
    api_key: str | None = None,
    on_text: Callable[[str], None] | None = None,
) -> ChatResult:
    """One model reply to `messages`, streamed: text chunks go to `on_text` as they arrive."""
    model = model.strip()
    emit = on_text or (lambda _: None)
    if model.startswith(MOCK_PREFIX):
        return await _mock(model, messages, tools if tool_choice != "none" else None, emit)

    litellm = await asyncio.to_thread(_load_litellm)
    qualified = qualify_model(model)
    provider = _PROVIDERS.get(qualified.split("/", 1)[0])
    if provider and not api_key and not any(os.environ.get(env) for env in provider[2]):
        # LiteLLM reports a missing key differently per provider; say it plainly instead.
        raise LlmError(
            f"No API key for {provider[0]}. Add one under API keys, set {provider[1]} in "
            "backend/.env, or use the mock/echo model to try the flow without one."
        )
    options: dict[str, Any] = {}
    if tools:
        options["tools"] = tools
        if tool_choice:
            options["tool_choice"] = tool_choice
    if api_key:
        options["api_key"] = api_key
    result = ChatResult()
    calls: dict[int, dict[str, str]] = {}
    try:
        response: Any = await litellm.acompletion(
            model=qualified,
            messages=messages,
            temperature=temperature,
            stream=True,
            timeout=get_settings().llm_timeout_seconds,
            **options,
        )
        async for chunk in response:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if text := delta.content:
                result.text += text
                emit(text)
            for part in getattr(delta, "tool_calls", None) or []:
                call = calls.setdefault(part.index or 0, {"id": "", "name": "", "arguments": ""})
                call["id"] = call["id"] or (part.id or "")
                if part.function is not None:
                    call["name"] += part.function.name or ""
                    call["arguments"] += part.function.arguments or ""
    except Exception as exc:  # provider boundary: every failure becomes a user-facing message
        raise LlmError(_describe(exc, qualified, litellm)) from exc
    result.tool_calls = [
        ToolCall(c["id"] or f"call_{i}", c["name"], c["arguments"])
        for i, c in sorted(calls.items())
    ]
    return result


def _describe(exc: Exception, model: str, litellm: ModuleType) -> str:
    provider = model.split("/", 1)[0] if "/" in model else ""
    name, env, _ = _PROVIDERS.get(provider, (provider or "the provider", "its API key", ()))
    errors = litellm.exceptions
    detail = str(exc).split("\n", 1)[0][:300]
    if isinstance(exc, errors.AuthenticationError):
        return (
            f"{name} rejected the request: no valid API key. Check the key under API keys or "
            f"{env} in backend/.env, or use the mock/echo model to try the flow without one."
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


# ── Mock models ───────────────────────────────────────────────────────────


async def _stream_words(text: str, emit: Callable[[str], None]) -> str:
    words = text.split(" ")
    for i, word in enumerate(words):
        await asyncio.sleep(MOCK_WORD_DELAY_SECONDS)
        emit(word if i == len(words) - 1 else f"{word} ")
    return text


async def _mock(
    model: str, messages: list[Message], tools: list[Tool] | None, emit: Callable[[str], None]
) -> ChatResult:
    if not get_settings().mock_models_enabled:
        raise LlmError("Mock models aren't available on this server.")
    if model not in MOCK_MODELS:
        raise LlmError(f"Unknown mock model “{model}” (available: {', '.join(MOCK_MODELS)}).")
    last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "") or ""

    if model == "mock/tools":
        if messages and messages[-1]["role"] == "tool":
            # Report the results of the last round of calls.
            names = {
                c["id"]: c["function"]["name"]
                for m in messages
                if m["role"] == "assistant"
                for c in m.get("tool_calls") or []
            }
            results = []
            for m in reversed(messages):
                if m["role"] != "tool":
                    break
                results.insert(0, f"{names.get(m['tool_call_id'], '?')}: {m['content']}")
            return ChatResult(await _stream_words("Tool results: " + " | ".join(results), emit))
        if tools:
            calls = [
                ToolCall(
                    f"mock_call_{i}",
                    t["function"]["name"],
                    json.dumps(
                        {p: last_user for p in t["function"]["parameters"].get("properties", {})}
                    ),
                )
                for i, t in enumerate(tools)
            ]
            return ChatResult(tool_calls=calls)
    return ChatResult(await _stream_words(last_user, emit))
