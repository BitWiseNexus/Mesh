"""Web tools: Web Search, API Caller, Web Scraper (no real network: mocked transports)."""

import asyncio
import json
from typing import Any

import httpx
import pytest

from app.core.config import Settings
from app.engine.compiler import compile_flow
from app.engine.context import RunContext
from app.engine.executor import NodeError, NodeResult
from app.engine.tools import agent_tools, get_tool_kind
from app.schemas.node_types import NodeType
from tests.flows import edge, flow, node, tool_edge


class KeySecrets:
    def __init__(self, **keys: str) -> None:
        self.keys = keys

    async def get(self, provider: str, credential_id: str | None = None) -> str | None:
        return self.keys.get(credential_id or provider)


def run_tool(
    tool_node: dict[str, Any], arguments: dict[str, Any], secrets: Any = None
) -> tuple[NodeResult, list[dict]]:
    """Calls the tool attached to an agent the way the agent would."""
    plan = compile_flow(
        flow(
            [node("t", "trigger_manual"), node("a", "agent_node", model="mock/tools"), tool_node],
            [edge("t", "a"), tool_edge("a", tool_node["id"])],
        )
    )
    [tool] = agent_tools(plan, "a")
    out: list[dict] = []
    ctx = RunContext(plan, run_id="r", input=None, sink=out.append, secrets=secrets)
    result = asyncio.run(tool.kind.run(ctx.node(tool.node.id, input=tool.input_from(arguments))))
    return result, out


def mock_http(monkeypatch: pytest.MonkeyPatch, module: str, handler) -> list[httpx.Request]:
    """Routes httpx.AsyncClient in `module` through `handler`; returns the requests made."""
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    real = httpx.AsyncClient

    def client(**kwargs: Any) -> httpx.AsyncClient:
        return real(transport=httpx.MockTransport(record), **kwargs)

    monkeypatch.setattr(f"{module}.httpx.AsyncClient", client)
    return seen


SEARCH = "app.nodes.executors.web_search"


class TestWebSearch:
    def test_tavily_with_the_users_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={"results": [{"title": "T", "url": "https://u", "content": "C", "score": 1}]},
            )

        seen = mock_http(monkeypatch, SEARCH, handler)
        result, out = run_tool(
            node("s", "tool_web_search", max_results=3),
            {"query": "mesh"},
            KeySecrets(tavily="tvly-user"),
        )
        assert result.output == [{"title": "T", "url": "https://u", "snippet": "C"}]
        assert seen[0].headers["Authorization"] == "Bearer tvly-user"
        assert json.loads(seen[0].content) == {
            "query": "mesh",
            "max_results": 3,
            "search_depth": "basic",
        }
        assert out == []

    @pytest.mark.parametrize(
        ("status", "message"),
        [(401, "rejected the API key"), (429, "rate-limiting"), (500, r"error \(500\)")],
    )
    def test_tavily_errors(
        self, monkeypatch: pytest.MonkeyPatch, status: int, message: str
    ) -> None:
        mock_http(monkeypatch, SEARCH, lambda r: httpx.Response(status, json={}))
        with pytest.raises(NodeError, match=message):
            run_tool(node("s", "tool_web_search"), {"query": "q"}, KeySecrets(tavily="k"))

    def test_tavily_network_failure(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def fail(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route")

        mock_http(monkeypatch, SEARCH, fail)
        with pytest.raises(NodeError, match="Couldn't reach Tavily"):
            run_tool(node("s", "tool_web_search"), {"query": "q"}, KeySecrets(tavily="k"))

    def test_without_a_tavily_key_it_searches_duckduckgo_and_says_so(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(f"{SEARCH}.get_settings", lambda: Settings(tavily_api_key=None))
        calls: list[tuple] = []

        class FakeDDGS:
            def __init__(self, timeout: int) -> None:
                pass

            def text(self, query: str, max_results: int) -> list[dict]:
                calls.append((query, max_results))
                return [{"title": "D", "href": "https://d", "body": "B"}]

        monkeypatch.setattr("ddgs.DDGS", FakeDDGS)
        result, out = run_tool(node("s", "tool_web_search", max_results=2), {"query": "ducks"})
        assert result.output == [{"title": "D", "url": "https://d", "snippet": "B"}]
        assert calls == [("ducks", 2)]
        assert out[0]["level"] == "warning" and "DuckDuckGo instead" in out[0]["message"]

    def test_duckduckgo_selected_and_failing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        class Broken:
            def __init__(self, timeout: int) -> None:
                pass

            def text(self, query: str, max_results: int) -> list[dict]:
                raise RuntimeError("Ratelimit")

        monkeypatch.setattr("ddgs.DDGS", Broken)
        with pytest.raises(NodeError, match="DuckDuckGo search failed: Ratelimit"):
            run_tool(node("s", "tool_web_search", provider="duckduckgo"), {"query": "q"})

    def test_empty_queries_are_refused(self) -> None:
        with pytest.raises(NodeError, match="query is empty"):
            run_tool(node("s", "tool_web_search", provider="duckduckgo"), {"query": "  "})

    def test_schema(self) -> None:
        kind = get_tool_kind(NodeType.TOOL_WEB_SEARCH)
        assert kind is not None and kind.parameters is not None
        assert kind.parameters["required"] == ["query"]
