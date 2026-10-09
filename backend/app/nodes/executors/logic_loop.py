"""Loop: repeats the nodes connected to its Loop output (scheduling: app/engine/runner.py)."""

from app.engine.context import NodeContext, to_text
from app.engine.executor import NodeResult, executor
from app.schemas.node_types import NodeType


@executor(NodeType.LOGIC_LOOP)
async def logic_loop(ctx: NodeContext) -> NodeResult:
    """Decides each time the loop is reached: `loop` (run the body again) or `done`.

    First the input that entered the loop always goes round once. After each pass the body's
    result comes back as the input; the loop is done when "Stop when output contains" is in it,
    or after "Max iterations" passes. The output is always the latest input."""
    passes = ctx.iteration
    limit = ctx.data.get("max_iterations")
    limit = limit if isinstance(limit, int) and limit >= 1 else 5
    until = ctx.field("until").strip()

    if passes >= limit:
        ctx.log(f"Done after {passes} iteration{'s' if passes != 1 else ''} (the maximum)")
        return NodeResult(ctx.input, handles=("done",))
    if passes > 0 and until and until.casefold() in to_text(ctx.input).casefold():
        ctx.log(f"Done after {passes} iteration{'s' if passes != 1 else ''}: found “{until}”")
        return NodeResult(ctx.input, handles=("done",))
    ctx.log(f"Iteration {passes + 1} of up to {limit}")
    return NodeResult(ctx.input, handles=("loop",))
