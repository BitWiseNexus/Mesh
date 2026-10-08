"""Web Search tool: Tavily (with an API key) or DuckDuckGo (no key needed)."""

import asyncio
from typing import Any

import httpx

from app.core.config import get_settings
from app.engine.context import NodeContext
from app.engine.executor import NodeError, NodeResult
from app.engine.tools import object_schema, tool
from app.schemas.node_types import NodeType

TAVILY_URL = "https://api.tavily.com/search"
TIMEOUT_SECONDS = 20


def _query(ctx: NodeContext) -> str:
    value = ctx.input.get("query") if isinstance(ctx.input, dict) else ctx.input
    if not isinstance(value, str) or not value.strip():
        raise NodeError("Nothing to search for: the query is empty")
    return value.strip()


@tool(
    NodeType.TOOL_WEB_SEARCH,
    parameters=object_schema({"query": "What to search the web for"}),
    description=lambda node: (
        "Search the web. Returns the top results, each with a title, url and snippet."
    ),
)
async def web_search(ctx: NodeContext) -> NodeResult:
    query = _query(ctx)
    count = ctx.data.get("max_results")
    count = count if isinstance(count, int) and 1 <= count <= 20 else 5
    if ctx.data.get("provider") == "tavily":
        settings_key = get_settings().tavily_api_key
        key = await ctx.run.secrets.get("tavily") or (
            settings_key.get_secret_value() if settings_key else None
        )
        if key:
            return NodeResult(await tavily(query, count, key))
        ctx.log(
            "No Tavily API key, so this searched DuckDuckGo instead. Add a Tavily key under "
            "API keys to use Tavily.",
            "warning",
        )
    return NodeResult(await duckduckgo(query, count))


async def tavily(query: str, count: int, key: str) -> list[dict[str, Any]]:
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
            response = await client.post(
                TAVILY_URL,
                json={"query": query, "max_results": count, "search_depth": "basic"},
                headers={"Authorization": f"Bearer {key}"},
            )
    except httpx.HTTPError as exc:
        raise NodeError(f"Couldn't reach Tavily: {exc}") from exc
    if response.status_code in (401, 403):
        raise NodeError("Tavily rejected the API key")
    if response.status_code == 429:
        raise NodeError("Tavily is rate-limiting searches (or the plan's quota is used up)")
    if response.is_error:
        raise NodeError(f"Tavily returned an error ({response.status_code})")
    results = response.json().get("results") or []
    return [
        {"title": r.get("title", ""), "url": r.get("url", ""), "snippet": r.get("content", "")}
        for r in results[:count]
    ]


async def duckduckgo(query: str, count: int) -> list[dict[str, Any]]:
    from ddgs import DDGS  # imported on use: it's only needed without a Tavily key

    try:
        results = await asyncio.to_thread(
            DDGS(timeout=TIMEOUT_SECONDS).text, query, max_results=count
        )
    except Exception as exc:  # ddgs raises its own exceptions for rate limits and timeouts
        raise NodeError(f"DuckDuckGo search failed: {exc}") from exc
    return [
        {"title": r.get("title", ""), "url": r.get("href", ""), "snippet": r.get("body", "")}
        for r in results[:count]
    ]
