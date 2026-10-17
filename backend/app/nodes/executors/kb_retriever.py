"""Retriever: the passages of a knowledge base most relevant to a query. As a step its Query field
says what to look for; attached to an agent's Tools handle, the agent writes the query."""

from app.engine.context import NodeContext
from app.engine.executor import NodeError, NodeResult, executor
from app.engine.tools import object_schema, tool
from app.schemas.node_types import NodeType

DEFAULT_TOP_K = 4


def _query(ctx: NodeContext) -> str:
    if ctx.node.role == "tool":
        value = ctx.input.get("query") if isinstance(ctx.input, dict) else ctx.input
    else:
        value = ctx.field("query")
    if not isinstance(value, str) or not value.strip():
        raise NodeError("Nothing to look up: the query is empty")
    return value.strip()


@tool(
    NodeType.KB_RETRIEVER,
    parameters=object_schema({"query": "What to look up: a question or keywords"}),
    description=lambda node: (
        "Search a knowledge base of documents. Returns the most relevant passages, each with its "
        "text, source document and relevance score; answer from them and cite the source."
    ),
)
@executor(NodeType.KB_RETRIEVER)
async def kb_retriever(ctx: NodeContext) -> NodeResult:
    knowledge_base_id = ctx.data.get("knowledge_base_id")
    if not isinstance(knowledge_base_id, str) or not knowledge_base_id:
        raise NodeError("Choose a knowledge base to search")
    top_k = ctx.data.get("top_k")
    top_k = top_k if isinstance(top_k, int) and 1 <= top_k <= 20 else DEFAULT_TOP_K
    query = _query(ctx)
    results = await ctx.run.knowledge.search(knowledge_base_id, query, top_k)
    if results:
        ctx.log(f"Found {len(results)} passage{'s' if len(results) != 1 else ''} for “{query}”")
    else:
        ctx.log("Nothing found: the knowledge base has no processed documents yet", level="warning")
    return NodeResult(results)
