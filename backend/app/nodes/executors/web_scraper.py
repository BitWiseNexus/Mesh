"""Web Scraper tool: fetch a page and return its readable content as markdown."""

import asyncio
from typing import Any

from app.engine.context import NodeContext
from app.engine.executor import NodeError, NodeResult
from app.engine.tools import object_schema, tool
from app.net import FetchError, fetch
from app.schemas.node_types import NodeType

ACCEPT = "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5"
TIMEOUT_SECONDS = 30
DEFAULT_MAX_CHARS = 20_000


def extract(html: str, url: str) -> tuple[str, str]:
    """(title, main content as markdown) of an HTML page. Falls back to all visible text for
    pages too small or unusual for main-content detection."""
    import trafilatura  # imported on use: takes a moment to load

    text = trafilatura.extract(
        html, url=url, output_format="markdown", include_formatting=True, favor_precision=True
    ) or trafilatura.html2txt(html)
    metadata = trafilatura.extract_metadata(html)
    return (metadata.title if metadata and metadata.title else ""), (text or "").strip()


@tool(
    NodeType.TOOL_WEB_SCRAPER,
    parameters=object_schema({"url": "The web page to read (http or https)"}),
    description=lambda node: (
        "Read a web page: returns its title and main text as markdown (no menus or ads)."
    ),
)
async def web_scraper(ctx: NodeContext) -> NodeResult:
    url = ctx.input.get("url") if isinstance(ctx.input, dict) else ctx.input
    if not isinstance(url, str) or not url.strip():
        raise NodeError("No URL to read")
    try:
        page = await fetch(
            "GET", url.strip(), headers={"Accept": ACCEPT}, request_timeout=TIMEOUT_SECONDS
        )
    except FetchError as exc:
        raise NodeError(str(exc)) from exc
    if page.status >= 400:
        raise NodeError(f"The page answered with an error ({page.status})")

    kind = page.content_type
    if kind in ("", "text/html", "application/xhtml+xml"):
        title, text = await asyncio.to_thread(extract, page.text(), page.url)
    elif kind.startswith("text/") or kind.endswith("json") or kind.endswith("xml"):
        title, text = "", page.text()
    else:
        raise NodeError(f"Can't read {kind} content: only web pages and text are supported")

    limit = ctx.data.get("max_chars")
    limit = limit if isinstance(limit, int) and limit > 0 else DEFAULT_MAX_CHARS
    result: dict[str, Any] = {"url": page.url, "title": title, "text": text[:limit]}
    if len(text) > limit or page.truncated:
        result["truncated"] = True
    return NodeResult(result)
