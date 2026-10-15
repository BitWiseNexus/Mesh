"""Approval Gate: waits for a person to approve or reject (pausing: app/engine/runner.py)."""

from app.engine.context import NodeContext
from app.engine.executor import AwaitApproval, NodeResult, executor
from app.schemas.node_types import NodeType


@executor(NodeType.HITL_APPROVAL)
async def hitl_approval(ctx: NodeContext) -> NodeResult:
    """Asks the reviewer about its input. The run continues — with the input, or the reviewer's
    edited version when "Reviewer can edit the content" is on — on `approved` or `rejected`."""
    message = ctx.field("message").strip() or "Please review"
    raise AwaitApproval(message, ctx.input, ctx.data.get("allow_edit") is not False)
