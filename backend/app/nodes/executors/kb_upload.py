"""Add to Knowledge Base: stores text produced in the run (e.g. a scraped page, an agent's notes)
as a Markdown document in a knowledge base, and waits until it's searchable — so a Retriever later
in the same run finds it."""

import re
from datetime import UTC, datetime

from app.engine.context import NodeContext
from app.engine.executor import NodeError, NodeResult, executor
from app.schemas.node_types import NodeType

_KEEP_EXTENSION = re.compile(r"\.(md|markdown|txt|text)$", re.IGNORECASE)


def document_name(title: str, now: datetime) -> str:
    """The stored file's name: the title (one line, no slashes) as Markdown, or the run time."""
    title = re.sub(r"\s+", " ", title.replace("/", "-").replace("\\", "-")).strip()
    if not title:
        title = f"Run output {now:%Y-%m-%d %H:%M} UTC"
    return title if _KEEP_EXTENSION.search(title) else f"{title}.md"


@executor(NodeType.KB_UPLOAD)
async def kb_upload(ctx: NodeContext) -> NodeResult:
    knowledge_base_id = ctx.data.get("knowledge_base_id")
    if not isinstance(knowledge_base_id, str) or not knowledge_base_id:
        raise NodeError("Choose a knowledge base to add to")
    content = ctx.field("content")
    if not content.strip():
        raise NodeError("Nothing to add: the content is empty")
    name = document_name(ctx.field("title"), datetime.now(UTC))
    ctx.log(f"Adding “{name}” ({len(content)} characters)")
    document = await ctx.run.knowledge.add_document(knowledge_base_id, name, content)
    chunks = document["chunk_count"]
    ctx.log(f"“{name}” is searchable ({chunks} chunk{'s' if chunks != 1 else ''})")
    return NodeResult(document)
