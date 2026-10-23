"""Supervisor Agent: an agent that coordinates the worker agents attached to its Tools handle.

It runs the same loop as an Agent (app/nodes/executors/agent.py) with built-in coordinator
instructions — its team, how to delegate, and that it writes the final answer — followed by the
node's own System prompt. A round is one batch of delegations (run in parallel); after Max
delegation rounds it must answer. Ordinary tools attached to it can be used too. It can itself be
a worker of another supervisor or agent.
"""

from app.engine.context import NodeContext
from app.engine.executor import NodeResult, executor
from app.engine.tools import AgentTool, tool
from app.nodes.executors.agent import AGENT_TASK, converse, steps_setting, tools_of
from app.schemas.node_types import NodeType

WORKER_TYPES = (NodeType.AGENT_NODE, NodeType.AGENT_SUPERVISOR)


def supervisor_instructions(tools: list[AgentTool], extra: str) -> str:
    workers = [t for t in tools if t.node.type in WORKER_TYPES]
    others = [t for t in tools if t.node.type not in WORKER_TYPES]
    lines = [
        "You are a supervisor. You lead a team of worker agents and are responsible for the "
        "final answer.",
        "",
    ]
    if workers:
        lines += ["Your workers (call them as tools):"]
        lines += [f"- {t.name}: {t.description}" for t in workers]
        lines += [
            "",
            "How to work:",
            "1. Break the task into sub-tasks and give each to the worker best suited to it.",
            "2. Workers only see what you send them: include every fact, constraint and the "
            "format you need in each request.",
            "3. Ask for independent sub-tasks at the same time (several tool calls in one turn); "
            "wait for results before sending sub-tasks that depend on them.",
            "4. Check what comes back. If something is missing or wrong, ask again with clearer "
            "instructions.",
            "5. Finally, write the answer yourself, combining the workers' results. Don't "
            "mention the delegation unless asked to.",
        ]
    else:
        lines += ["You have no workers attached: do the task yourself."]
    if others:
        lines += ["", "You can also use these tools directly:"]
        lines += [f"- {t.name}: {t.description}" for t in others]
    if extra.strip():
        lines += ["", "Further instructions:", extra.strip()]
    return "\n".join(lines)


@tool(
    NodeType.AGENT_SUPERVISOR,
    description=lambda node: (
        f"Ask the “{node.name}” supervisor, who leads a team of agents, to take on a task; it "
        "answers with text. Pass everything it needs to know."
    ),
    input_description=AGENT_TASK,
)
@executor(NodeType.AGENT_SUPERVISOR)
async def supervisor(ctx: NodeContext) -> NodeResult:
    tools = tools_of(ctx)
    instructions = supervisor_instructions(list(tools.values()), ctx.field("system_prompt"))
    return await converse(ctx, instructions, steps_setting(ctx, "max_rounds"), tools)
