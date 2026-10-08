from app.engine.context import NodeContext
from app.engine.executor import NodeResult, executor
from app.schemas.node_types import NodeType


@executor(NodeType.OUTPUT_DISPLAY)
async def output_display(ctx: NodeContext) -> NodeResult:
    """Shows its input in the run panel: the output is the input, unchanged."""
    return NodeResult(ctx.input)
