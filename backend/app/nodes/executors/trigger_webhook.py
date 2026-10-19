from app.engine.context import NodeContext
from app.engine.executor import NodeResult, executor
from app.schemas.node_types import NodeType
from app.services.webhooks import stand_in_body, webhook_request


@executor(NodeType.TRIGGER_WEBHOOK)
async def webhook_trigger(ctx: NodeContext) -> NodeResult:
    """Outputs the request that started the run (app/api/webhooks.py). Runs started another way
    (the editor's Run button) get a stand-in request whose body is the run's input text or, without
    one, the node's Test body."""
    if isinstance(ctx.run.input, dict):
        return NodeResult(ctx.run.input)
    if isinstance(ctx.run.input, str):
        text, source = ctx.run.input, "the run's input"
    else:
        text, source = str(ctx.data.get("test_body") or ""), "the Test body"
    ctx.log(f"Started without a request: {source} stands in for the request body")
    method = str(ctx.data.get("method") or "POST")
    return NodeResult(webhook_request(method, {}, {}, stand_in_body(text)))
