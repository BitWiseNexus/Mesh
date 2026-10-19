"""Webhook triggers: a request to a Webhook trigger's URL starts a run of its flow.

    GET|POST|PUT /hooks/{flow_id}/{node_id}

No sign-in: the URL is the key (flow ids are random), plus the trigger's optional secret, sent in
the `X-Mesh-Secret` header. The run starts at that trigger, runs the flow as last saved, as its
owner (their API keys and knowledge bases), and continues after the response — the owner finds it
in the flow's run history. The trigger outputs the request (app/services/webhooks.py).

The answer:
- the run has no HTTP Response node → at once, 202 `{"run_id", "status": "queued"}`
- otherwise the caller waits for the first HTTP Response node to run and gets its status code,
  headers and body (the run carries on after it). If none does: the run paused for an approval →
  202 status "paused"; it ended → `{"run_id", "status"}`, 500 if it failed, else 200; still
  going after `webhook_response_timeout_seconds` → 202 status "running".

Errors: 404 `webhook_not_found`, 401 `invalid_webhook_secret`, 405 `method_not_allowed`, 429
`rate_limited` (per webhook, with Retry-After) / `too_many_runs` (the owner's active runs), 413
`webhook_body_too_large`, 400 `invalid_body`, 415 `unsupported_body`, 422 `flow_not_runnable`.
Callers never see the flow's contents: the details of why it can't run stay in the editor.
"""

import asyncio
import hmac
import logging
import math
from typing import Annotated

from fastapi import APIRouter, Path, Request, Response, status
from fastapi.responses import JSONResponse

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
from app.services.runs import RunEventLog
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
    response_class=Response,
)
async def call_webhook(
    flow_id: FlowId,
    node_id: NodeId,
    request: Request,
    flows: FlowRepo,
    runs: Runs,
    manager: Manager,
    ingestion: Ingestion,
) -> Response:
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
        plan = compile_flow(stored, node_id)
        info = await launch_run(
            owner_uid=owner_uid,
            stored=stored,
            plan=plan,
            input=payload,
            runs=runs,
            manager=manager,
            ingestion=ingestion,
        )
    except (FlowNotRunnableError, NodesNotRunnableError):
        raise WebhookFlowNotRunnableError() from None
    logger.info("Webhook %s/%s started run %s", flow_id, node_id, info.run_id)

    responders = {n.id for n in plan.steps if n.type is NodeType.ACTION_HTTP_RESPONSE}
    live = manager.get(info.run_id)
    if not responders or live is None:
        return _accepted(info.run_id, "queued")
    try:
        async with asyncio.timeout(get_settings().webhook_response_timeout_seconds):
            return await _response(live.log, info.run_id, responders)
    except TimeoutError:
        return _accepted(info.run_id, "running")


def _accepted(run_id: str, run_status: str, code: int = status.HTTP_202_ACCEPTED) -> Response:
    return JSONResponse({"run_id": run_id, "status": run_status}, status_code=code)


async def _response(log: RunEventLog, run_id: str, responders: set[str]) -> Response:
    """The first HTTP Response node's answer; or, when the run ends or pauses without one, what
    became of it (see the module docstring)."""
    async for event in log.follow():
        if event is None:
            continue
        if (
            event["type"] == "node_finished"
            and event["node_id"] in responders
            and event["status"] == "succeeded"
        ):
            answer = event["output"]
            return Response(
                answer["body"].encode(),
                status_code=answer["status_code"],
                headers=answer["headers"],
            )
        if event["type"] == "run_paused":
            return _accepted(run_id, "paused")
        if event["type"] == "run_finished":
            break
    final = next((e["status"] for e in reversed(log.events) if e["type"] == "run_finished"), None)
    if final == "failed":
        return _accepted(run_id, "failed", status.HTTP_500_INTERNAL_SERVER_ERROR)
    return _accepted(run_id, final or "succeeded", status.HTTP_200_OK)
