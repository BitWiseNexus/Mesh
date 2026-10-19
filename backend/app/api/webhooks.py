"""Webhook triggers: a request to a Webhook trigger's URL starts a run of its flow.

    GET|POST|PUT /hooks/{flow_id}/{node_id}   → 202 {"run_id", "status": "queued"}

No sign-in: the URL is the key (flow ids are random), plus the trigger's optional secret, sent in
the `X-Mesh-Secret` header. The run starts at that trigger, runs the flow as last saved, as its
owner (their API keys and knowledge bases), and continues after the response — the owner finds it
in the flow's run history. The trigger outputs the request (app/services/webhooks.py).

Errors: 404 `webhook_not_found`, 401 `invalid_webhook_secret`, 405 `method_not_allowed`, 429
`rate_limited` (per webhook, with Retry-After) / `too_many_runs` (the owner's active runs), 413
`webhook_body_too_large`, 400 `invalid_body`, 415 `unsupported_body`, 422 `flow_not_runnable`.
Callers never see the flow's contents: the details of why it can't run stay in the editor.
"""

import hmac
import logging
import math
from typing import Annotated

from fastapi import APIRouter, Path, Request, status
from pydantic import BaseModel

from app.api.flows import FlowId
from app.api.flows import Repo as FlowRepo
from app.api.knowledge import Ingestion
from app.api.runs import Manager, Runs
from app.core.config import get_settings
from app.core.errors import ApiError, NotFoundError, PayloadTooLargeError
from app.engine.compiler import FlowNotRunnableError, compile_flow
from app.repositories.flows import FlowNotFoundError
from app.schemas.node_types import NodeType
from app.services.launch import NodesNotRunnableError, launch_run
from app.services.webhooks import (
    SECRET_HEADER,
    collect_fields,
    parse_body,
    visible_headers,
    webhook_request,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["webhooks"])

NodeId = Annotated[str, Path(min_length=1, max_length=200)]


class WebhookNotFoundError(NotFoundError):
    code = "webhook_not_found"
    message = (
        "There's no webhook at this URL. The flow or its Webhook trigger may have been deleted, "
        "or the flow hasn't been saved since the trigger was added."
    )


class InvalidSecretError(ApiError):
    status_code = 401
    code = "invalid_webhook_secret"
    message = f"Missing or wrong secret: send it in the {SECRET_HEADER.title()} header."


class MethodNotAllowedError(ApiError):
    status_code = 405
    code = "method_not_allowed"

    def __init__(self, allowed: str) -> None:
        super().__init__(f"This webhook accepts {allowed} requests.")
        self.headers = {"Allow": allowed}


class RateLimitedError(ApiError):
    status_code = 429
    code = "rate_limited"

    def __init__(self, retry_after: float) -> None:
        seconds = max(1, math.ceil(retry_after))
        super().__init__(f"Too many requests to this webhook. Try again in {seconds} s.")
        self.headers = {"Retry-After": str(seconds)}


class BodyTooLargeError(PayloadTooLargeError):
    code = "webhook_body_too_large"

    def __init__(self, limit: int) -> None:
        super().__init__(f"The request body is too large (at most {limit:,} bytes).")


class WebhookFlowNotRunnableError(ApiError):
    status_code = 422
    code = "flow_not_runnable"
    message = "The flow can't run: it has problems. Open it in Mesh to see and fix them."


class WebhookAccepted(BaseModel):
    run_id: str
    status: str = "queued"


async def read_body(request: Request, limit: int) -> bytes:
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise BodyTooLargeError(limit)
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > limit:
            raise BodyTooLargeError(limit)
    return bytes(body)


@router.api_route(
    "/hooks/{flow_id}/{node_id}",
    methods=["GET", "POST", "PUT"],
    status_code=status.HTTP_202_ACCEPTED,
)
async def call_webhook(
    flow_id: FlowId,
    node_id: NodeId,
    request: Request,
    flows: FlowRepo,
    runs: Runs,
    manager: Manager,
    ingestion: Ingestion,
) -> WebhookAccepted:
    try:
        owner_uid, stored = await flows.get_with_owner(flow_id)
    except FlowNotFoundError:
        raise WebhookNotFoundError() from None
    hook = next((n for n in stored.nodes if n.id == node_id), None)
    if hook is None or hook.type is not NodeType.TRIGGER_WEBHOOK:
        raise WebhookNotFoundError()

    secret = str(hook.data.get("secret") or "").strip()
    given = request.headers.get(SECRET_HEADER, "").strip()
    if secret and not hmac.compare_digest(given.encode(), secret.encode()):
        raise InvalidSecretError()
    method = str(hook.data.get("method") or "POST").upper()
    if request.method != method:
        raise MethodNotAllowedError(method)
    if (retry_after := request.app.state.webhook_limiter.hit(f"{flow_id}/{node_id}")) is not None:
        raise RateLimitedError(retry_after)

    raw = await read_body(request, get_settings().webhook_max_body_bytes)
    payload = webhook_request(
        method,
        collect_fields(request.query_params.multi_items()),
        visible_headers(request.headers.items()),
        parse_body(request.headers.get("content-type", ""), raw),
    )
    try:
        info = await launch_run(
            owner_uid=owner_uid,
            stored=stored,
            plan=compile_flow(stored, node_id),
            input=payload,
            runs=runs,
            manager=manager,
            ingestion=ingestion,
        )
    except (FlowNotRunnableError, NodesNotRunnableError):
        raise WebhookFlowNotRunnableError() from None
    logger.info("Webhook %s/%s started run %s", flow_id, node_id, info.run_id)
    return WebhookAccepted(run_id=info.run_id)
