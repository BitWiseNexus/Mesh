from datetime import UTC, datetime

from app.engine.context import NodeContext
from app.engine.executor import NodeResult, executor
from app.schemas.node_types import NodeType
from app.services.cron import load_timezone


@executor(NodeType.TRIGGER_CRON)
async def schedule_trigger(ctx: NodeContext) -> NodeResult:
    """Outputs when the run was due: `{scheduled_at, timezone}` (from app/services/schedules.py).
    Runs started another way (the editor's Run button) use the current time."""
    if isinstance(ctx.run.input, dict):
        return NodeResult(ctx.run.input)
    zone = load_timezone(str(ctx.data.get("timezone") or "")) or load_timezone("UTC")
    assert zone is not None
    ctx.log("Started by hand, not by the schedule: using the current time")
    now = datetime.now(UTC).astimezone(zone).replace(microsecond=0)
    return NodeResult({"scheduled_at": now.isoformat(), "timezone": zone.key})
