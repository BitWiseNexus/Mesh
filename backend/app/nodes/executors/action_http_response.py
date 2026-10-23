from app.engine.context import NodeContext
from app.engine.escaping import escape_json_strings, looks_like_json
from app.engine.executor import NodeError, NodeResult, executor
from app.schemas.node_types import NodeType
from app.services.webhooks import ResponseError, build_response


@executor(NodeType.ACTION_HTTP_RESPONSE)
async def http_response(ctx: NodeContext) -> NodeResult:
    """Prepares the answer to the request that started the run: `{status_code, headers, body}`.
    The webhook endpoint (app/api/webhooks.py) waits for the first of these and sends it; in runs
    without a waiting caller (editor, schedule, a resumed run) it only shows what would be sent."""
    template = str(ctx.data.get("body") or "")
    # JSON written around references ({"greeting": "{{input}}"}): values are escaped into it.
    body = ctx.value(template, escape_json_strings if looks_like_json(template) else None)
    try:
        response = build_response(
            ctx.data.get("status_code"),
            str(ctx.data.get("content_type") or "auto"),
            ctx.data.get("headers") or {},
            body,
        )
    except ResponseError as exc:
        raise NodeError(str(exc)) from None
    content_type = response["headers"].get("Content-Type", "no body")
    ctx.log(f"Response ready: {response['status_code']} ({content_type})")
    return NodeResult(response)
