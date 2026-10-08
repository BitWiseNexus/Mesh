"""The LLM layer (app/llm): model names, streaming, tool calls, mock models, provider errors."""

import asyncio
from types import SimpleNamespace

import pytest

import app.llm as llm
from app.core.config import Settings
from app.llm import ChatResult, LlmError, ToolCall, complete, provider_of, qualify_model

REAL_LITELLM = llm._load_litellm()


def collect(model: str, text: str = "one two three", **kwargs) -> list[str]:
    """The streamed text chunks of one reply."""
    chunks: list[str] = []
    result = asyncio.run(
        complete(model, [{"role": "user", "content": text}], on_text=chunks.append, **kwargs)
    )
    assert result.text == "".join(chunks)
    return chunks


def test_litellm_leaves_the_apps_loggers_alone() -> None:
    """Regression: LiteLLM's log filters on uvicorn/asyncio/httpx loggers broke requests while
    LiteLLM was still being imported in the warm-up thread (CI's backend never became ready)."""
    import logging

    from litellm import _logging

    assert _logging._ENABLE_SECRET_REDACTION is False
    record = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, "%s", ("GET /health",), None)
    for name in ("uvicorn.access", "uvicorn.error", "asyncio", "httpx"):
        assert logging.getLogger(name).filter(record)


def chunk(content=None, tool_calls=None):
    delta = SimpleNamespace(content=content, tool_calls=tool_calls)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])


def call_part(index, id=None, name=None, arguments=None):
    return SimpleNamespace(
        index=index, id=id, function=SimpleNamespace(name=name, arguments=arguments)
    )


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


def test_provider_of() -> None:
    assert [provider_of(m) for m in ("gpt-4o", "claude-x", "gemini/x", "mistral", "mock/echo")] == [
        "openai",
        "anthropic",
        "gemini",
        None,
        None,
    ]


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
    with pytest.raises(LlmError, match="No API key for OpenAI. Add one under API keys"):
        collect("gpt-4o")


def _fake_litellm(acompletion):
    return SimpleNamespace(acompletion=acompletion, exceptions=REAL_LITELLM.exceptions)


def test_streams_provider_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict] = []

    async def acompletion(**kwargs):
        calls.append(kwargs)

        async def chunks():
            for text in ("Hi", None, " there"):
                yield chunk(text)
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


def test_assembles_streamed_tool_calls_and_passes_the_callers_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict] = []

    async def acompletion(**kwargs):
        calls.append(kwargs)

        async def chunks():
            yield chunk("Let me look.")
            yield chunk(tool_calls=[call_part(0, "c1", "web_search", '{"que')])
            yield chunk(
                tool_calls=[call_part(0, None, None, 'ry": "x"}'), call_part(1, "c2", "api")]
            )
            yield chunk(tool_calls=[call_part(1, None, None, "{}")])

        return chunks()

    monkeypatch.setattr(llm, "_load_litellm", lambda: _fake_litellm(acompletion))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)  # the caller's key is enough
    tools = [{"type": "function", "function": {"name": "web_search", "parameters": {}}}]
    result = asyncio.run(
        complete(
            "gpt-4o",
            [{"role": "user", "content": "hi"}],
            tools=tools,
            tool_choice="auto",
            api_key="sk-user",
        )
    )
    assert result == ChatResult(
        "Let me look.",
        [ToolCall("c1", "web_search", '{"query": "x"}'), ToolCall("c2", "api", "{}")],
    )
    assert calls[0]["tools"] == tools and calls[0]["tool_choice"] == "auto"
    assert calls[0]["api_key"] == "sk-user"
    assert result.assistant_message() == {
        "role": "assistant",
        "content": "Let me look.",
        "tool_calls": [
            {
                "id": "c1",
                "type": "function",
                "function": {"name": "web_search", "arguments": '{"query": "x"}'},
            },
            {"id": "c2", "type": "function", "function": {"name": "api", "arguments": "{}"}},
        ],
    }


def test_mock_tools_calls_each_tool_then_reports_the_results() -> None:
    tools = [
        {
            "type": "function",
            "function": {"name": "search", "parameters": {"properties": {"query": {}}}},
        },
        {"type": "function", "function": {"name": "ping", "parameters": {"properties": {}}}},
    ]
    messages = [{"role": "user", "content": "cats"}]
    first = asyncio.run(complete("mock/tools", messages, tools=tools))
    assert first.text == ""
    assert first.tool_calls == [
        ToolCall("mock_call_0", "search", '{"query": "cats"}'),
        ToolCall("mock_call_1", "ping", "{}"),
    ]
    messages += [
        first.assistant_message(),
        {"role": "tool", "tool_call_id": "mock_call_0", "content": "3 results"},
        {"role": "tool", "tool_call_id": "mock_call_1", "content": "pong"},
    ]
    second = asyncio.run(complete("mock/tools", messages, tools=tools))
    assert second == ChatResult("Tool results: search: 3 results | ping: pong")
    # Without tools it behaves like mock/echo.
    assert asyncio.run(complete("mock/tools", [{"role": "user", "content": "hi"}])).text == "hi"
