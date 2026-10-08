"""The LLM layer (app/llm): model names, mock models, provider errors."""

import asyncio
from types import SimpleNamespace

import pytest

import app.llm as llm
from app.core.config import Settings
from app.llm import LlmError, qualify_model, stream_chat

REAL_LITELLM = llm._load_litellm()


def collect(model: str, text: str = "one two three") -> list[str]:
    async def main() -> list[str]:
        return [c async for c in stream_chat(model, [{"role": "user", "content": text}])]

    return asyncio.run(main())


@pytest.mark.parametrize(
    ("model", "qualified"),
    [
        ("gpt-4o", "openai/gpt-4o"),
        ("o3-mini", "openai/o3-mini"),
        (" claude-sonnet-5-5 ", "anthropic/claude-sonnet-5-5"),
        ("gemini-2.5-flash", "gemini/gemini-2.5-flash"),
        ("anthropic/claude-x", "anthropic/claude-x"),
        ("vertex_ai/gemini-2.5-pro", "vertex_ai/gemini-2.5-pro"),
        ("mistral-large", "mistral-large"),
    ],
)
def test_qualify_model(model: str, qualified: str) -> None:
    assert qualify_model(model) == qualified


def test_mock_echo_streams_the_last_user_message_word_by_word() -> None:
    assert collect("mock/echo") == ["one ", "two ", "three"]


def test_mock_models_are_off_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    prod = Settings(environment="production", use_firebase_emulators=False)
    monkeypatch.setattr(llm, "get_settings", lambda: prod)
    with pytest.raises(LlmError, match="aren't available"):
        collect("mock/echo")


def test_missing_provider_key_is_explained(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm, "_load_litellm", lambda: SimpleNamespace())
    for env in ("OPENAI_API_KEY",):
        monkeypatch.delenv(env, raising=False)
    with pytest.raises(LlmError, match="No API key for OpenAI. Set OPENAI_API_KEY"):
        collect("gpt-4o")


def _fake_litellm(acompletion):
    return SimpleNamespace(acompletion=acompletion, exceptions=REAL_LITELLM.exceptions)


def test_streams_provider_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict] = []

    async def acompletion(**kwargs):
        calls.append(kwargs)

        async def chunks():
            for text in ("Hi", None, " there"):
                yield SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content=text))]
                )
            yield SimpleNamespace(choices=[])

        return chunks()

    fake = _fake_litellm(acompletion)
    monkeypatch.setattr(llm, "_load_litellm", lambda: fake)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    assert collect("claude-sonnet-5-5") == ["Hi", " there"]
    assert calls[0]["model"] == "anthropic/claude-sonnet-5-5" and calls[0]["stream"] is True


def test_provider_errors_become_readable(monkeypatch: pytest.MonkeyPatch) -> None:
    errors = REAL_LITELLM.exceptions

    def failing(exc: Exception):
        async def acompletion(**kwargs):
            raise exc

        return _fake_litellm(acompletion)

    monkeypatch.setenv("OPENAI_API_KEY", "sk-bad")
    cases = [
        (errors.AuthenticationError("bad key", "openai", "gpt-4o"), "OpenAI rejected the request"),
        (errors.RateLimitError("slow down", "openai", "gpt-4o"), "rate-limiting"),
        (errors.NotFoundError("nope", "gpt-9", "openai"), "doesn't know the model “gpt-9”"),
        (RuntimeError("socket closed"), "OpenAI returned an error: socket closed"),
    ]
    for exc, message in cases:
        monkeypatch.setattr(llm, "_load_litellm", lambda exc=exc: failing(exc))
        model = "gpt-9" if "gpt-9" in message else "gpt-4o"
        with pytest.raises(LlmError, match=message):
            collect(model)
