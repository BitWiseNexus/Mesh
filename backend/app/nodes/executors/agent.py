from app.engine.context import NodeContext
from app.engine.executor import NodeError, NodeResult, executor
from app.llm import LlmError, Message, stream_chat
from app.schemas.node_types import NodeType


@executor(NodeType.AGENT_NODE)
async def agent(ctx: NodeContext) -> NodeResult:
    """One LLM call: the system prompt as instructions, the Task as the user message. The reply
    streams as token events; the full text is the output. (Tool calling: Phase 4.)"""
    model = ctx.data.get("model")
    if not isinstance(model, str) or not model.strip():
        raise NodeError("Choose a model")
    task = ctx.field("prompt")
    if not task.strip():
        raise NodeError("The Task is empty — nothing to send to the model")

    messages: list[Message] = []
    if system := ctx.field("system_prompt").strip():
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": task})

    temperature = ctx.data.get("temperature")
    reply: list[str] = []
    try:
        async for text in stream_chat(
            model,
            messages,
            temperature=temperature if isinstance(temperature, int | float) else None,
        ):
            reply.append(text)
            ctx.token(text)
    except LlmError as exc:
        raise NodeError(str(exc)) from exc
    return NodeResult("".join(reply))
