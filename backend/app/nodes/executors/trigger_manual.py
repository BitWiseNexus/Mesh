from app.engine.context import NodeContext
from app.engine.executor import NodeResult, executor
from app.schemas.node_types import NodeType


@executor(NodeType.TRIGGER_MANUAL)
async def manual_trigger(ctx: NodeContext) -> NodeResult:
    """Outputs the text the run was started with, or the node's default input."""
    if ctx.run.input is not None:
        return NodeResult(ctx.run.input)
    default = ctx.data.get("input")
    return NodeResult(default if isinstance(default, str) else "")
