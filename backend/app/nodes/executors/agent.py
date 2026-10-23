import asyncio

from app.engine.context import NodeContext
from app.engine.executor import NodeError, NodeResult, executor
from app.engine.tools import AgentTool, agent_tools, call_tool, tool
from app.llm import LlmError, Message, complete, provider_of
from app.schemas.node_types import NodeType

#: What an agent used as a tool (or worker) receives: its Task's `{{input}}`.
AGENT_TASK = "The task: everything the agent needs to know (it can't see this conversation)"


@tool(
    NodeType.AGENT_NODE,
    description=lambda node: (
        f"Ask the “{node.name}” agent to do something; it answers with text. Pass everything it "
        "needs to know."
    ),
    input_description=AGENT_TASK,
)
@executor(NodeType.AGENT_NODE)
async def agent(ctx: NodeContext) -> NodeResult:
    """An LLM with a system prompt and a Task, which can call the nodes attached to its Tools
    handle. Up to `max_tool_steps` rounds of tool calls (each round's calls run in parallel), then
    it must answer. Text streams as token events; the output is the final answer.

    Also runs agents attached to another agent as tools: their `{{input}}` is the arguments."""
    return await converse(ctx, ctx.field("system_prompt"), steps_setting(ctx, "max_tool_steps"))


def steps_setting(ctx: NodeContext, key: str, default: int = 5) -> int:
    value = ctx.data.get(key)
    valid = isinstance(value, int) and not isinstance(value, bool) and value > 0
    return value if valid else default


def tools_of(ctx: NodeContext) -> dict[str, AgentTool]:
    return {t.name: t for t in agent_tools(ctx.run.plan, ctx.node.id)}


async def converse(
    ctx: NodeContext,
    system_prompt: str,
    max_steps: int,
    tools: dict[str, AgentTool] | None = None,
) -> NodeResult:
    """The agent loop shared by Agent and Supervisor: system prompt + Task, then up to
    `max_steps` rounds of tool calls before the model has to answer."""
    model = ctx.data.get("model")
    if not isinstance(model, str) or not model.strip():
        raise NodeError("Choose a model")
    task = ctx.field("prompt")
    if not task.strip():
        raise NodeError("The Task is empty — nothing to send to the model")

    messages: list[Message] = []
    if system := system_prompt.strip():
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": task})

    # The owner's chosen key, or their key for the model's provider, or (None) the server's.
    provider = provider_of(model)
    credential_id = ctx.data.get("credential_id")
    credential_id = credential_id if isinstance(credential_id, str) and credential_id else None
    api_key = (
        await ctx.run.secrets.get(provider or "", credential_id)
        if provider or credential_id
        else None
    )

    temperature = ctx.data.get("temperature")
    tools = tools_of(ctx) if tools is None else tools
    schemas = [t.schema() for t in tools.values()] or None

    for step in range(max_steps + 1):
        try:
            reply = await complete(
                model,
                messages,
                tools=schemas,
                # Last round: the model has to answer with what it has.
                tool_choice="none" if schemas and step == max_steps else None,
                temperature=temperature if isinstance(temperature, int | float) else None,
                api_key=api_key,
                on_text=ctx.token,
            )
        except LlmError as exc:
            raise NodeError(str(exc)) from exc
        if not reply.tool_calls or step == max_steps:
            return NodeResult(reply.text)
        if reply.text:
            ctx.token("\n\n")  # keep text from before and after the tool calls apart
        messages.append(reply.assistant_message())
        results = await asyncio.gather(
            *(
                call_tool(ctx, tools, call.id, call.name, call.arguments)
                for call in reply.tool_calls
            )
        )
        messages.extend(
            {"role": "tool", "tool_call_id": call.id, "content": content}
            for call, content in zip(reply.tool_calls, results, strict=True)
        )
    raise AssertionError("unreachable")  # the last round always returns
