"""Runs: start a flow, watch it live (SSE), stop it, read its record.

    POST /flows/{flow_id}/runs     start a run of the flow's saved version → 201 RunInfo
    GET  /flows/{flow_id}/runs     the flow's latest runs (history), newest first
    GET  /runs/{run_id}            the run's record (statuses + outputs)
    GET  /runs/{run_id}/stream     Server-Sent Events, see below
    POST /runs/{run_id}/cancel     stop a live run → RunInfo once it's recorded as cancelled

The stream replays every event of a live run (resume with `Last-Event-ID: <seq>`), then follows
it until `run_finished`; idle streams get `: ping` comments. For a run that is no longer live it
sends one `snapshot` event (`{"type": "snapshot", "run": RunInfo}`) and ends. Event types:
app/engine/events.py. Auth is the usual Bearer token, so browsers read it with fetch(), not
EventSource (which can't send headers).
"""

import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Path, Query, Request, status
from fastapi.responses import StreamingResponse

from app.api.flows import FlowId
from app.api.flows import Repo as FlowRepo
from app.api.knowledge import Ingestion
from app.core.auth import CurrentUser
from app.core.config import get_settings
from app.core.errors import ApiError
from app.core.firebase import get_db
from app.engine.compiler import ExecutionPlan, compile_flow
from app.engine.executor import not_runnable_issues
from app.engine.runner import Decision
from app.engine.validation import FlowIssue
from app.repositories.chunks import ChunkRepository
from app.repositories.credentials import CredentialRepository
from app.repositories.knowledge import KnowledgeBaseRepository
from app.repositories.runs import RunRepository
from app.schemas.flow import Flow
from app.schemas.runs import (
    ApprovalDecision,
    PendingApprovalItem,
    RunInfo,
    RunRequest,
    RunSummary,
)
from app.services.credentials import UserSecrets
from app.services.ingestion import IngestionManager
from app.services.knowledge import UserKnowledge
from app.services.runs import RunManager

router = APIRouter(tags=["runs"])


class NodesNotRunnableError(ApiError):
    status_code = 422
    code = "nodes_not_runnable"
    message = "Some nodes in this flow can't run yet."

    def __init__(self, issues: list[FlowIssue]) -> None:
        super().__init__(issues=[i.model_dump(exclude_none=True) for i in issues])


class TooManyRunsError(ApiError):
    status_code = 429
    code = "too_many_runs"
    message = "You have too many runs in progress. Wait for one to finish or stop it."


def get_run_repository() -> RunRepository:
    return RunRepository(get_db())


def get_run_manager(request: Request) -> RunManager:
    return request.app.state.runs


Runs = Annotated[RunRepository, Depends(get_run_repository)]
Manager = Annotated[RunManager, Depends(get_run_manager)]
RunId = Annotated[str, Path(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")]


def _owner_services(owner_uid: str, ingestion: IngestionManager) -> dict[str, Any]:
    """What a run needs of its owner's account: saved API keys and knowledge bases."""
    db = get_db()
    secrets = UserSecrets(CredentialRepository(db), owner_uid)
    knowledge = UserKnowledge(
        KnowledgeBaseRepository(db), ChunkRepository(db), owner_uid, secrets, ingestion
    )
    return {"secrets": secrets, "knowledge": knowledge}


@router.post("/flows/{flow_id}/runs", status_code=status.HTTP_201_CREATED)
async def start_run(
    flow_id: FlowId,
    body: RunRequest,
    user: CurrentUser,
    flows: FlowRepo,
    runs: Runs,
    manager: Manager,
    ingestion: Ingestion,
) -> RunInfo:
    """Runs the flow as last saved (save first: the editor does). 422 `flow_invalid` /
    `invalid_trigger` / `nodes_not_runnable` with `issues`, 429 `too_many_runs`."""
    stored = await flows.get(user.uid, flow_id)
    plan = compile_flow(stored, body.trigger_id)
    if issues := not_runnable_issues(plan):
        raise NodesNotRunnableError(issues)
    if manager.active_runs(user.uid) >= get_settings().max_active_runs_per_user:
        raise TooManyRunsError()
    info = await runs.create(
        owner_uid=user.uid,
        flow_id=flow_id,
        flow_name=stored.name,
        flow_version=stored.version,
        trigger_id=plan.trigger_id,
        input=body.input,
    )
    manager.start(
        run_id=info.run_id,
        owner_uid=user.uid,
        plan=plan,
        input=body.input,
        repository=runs,
        **_owner_services(user.uid, ingestion),
        # Kept with the checkpoint if the run pauses: it resumes the flow as it was run.
        flow_snapshot=Flow.model_validate(stored.model_dump()).model_dump(mode="json"),
    )
    return info


@router.post("/runs/{run_id}/approvals/{node_id}")
async def answer_approval(
    run_id: RunId,
    node_id: Annotated[str, Path(min_length=1, max_length=200)],
    body: ApprovalDecision,
    user: CurrentUser,
    runs: Runs,
    manager: Manager,
    ingestion: Ingestion,
) -> RunInfo:
    """Approves or rejects a waiting Approval Gate; the paused run continues (follow it with the
    stream). Send `content` to continue with an edited version (if the gate allows it). 409
    `run_not_paused`, 404 `approval_not_found`, 422 `edit_not_allowed`, 429 `too_many_runs`."""
    if manager.active_runs(user.uid) >= get_settings().max_active_runs_per_user:
        raise TooManyRunsError()
    edited = "content" in body.model_fields_set
    reserved = manager.reserve(run_id, user.uid)
    try:
        await runs.claim_for_resume(user.uid, run_id, node_id, edited=edited)
        saved = await runs.load_checkpoint(run_id)
        plan = _plan_from_checkpoint(saved)
    except ResumeFailedError as failure:
        manager.release(run_id)
        await runs.update(
            run_id,
            {"status": "failed", "error": str(failure), "finished_at": datetime.now(UTC)},
        )
        raise
    except Exception:
        manager.release(run_id)
        raise
    assert saved is not None
    manager.start(
        run_id=run_id,
        owner_uid=user.uid,
        plan=plan,
        input=None,  # the checkpoint has the run's input
        repository=runs,
        **_owner_services(user.uid, ingestion),
        checkpoint=saved,
        decisions=[Decision(node_id, body.approved, body.content if edited else None, edited)],
        reserved=reserved,
    )
    return await runs.get(user.uid, run_id, live=True)


class ResumeFailedError(ApiError):
    status_code = 409
    code = "resume_failed"
    message = "This run can't continue."


def _plan_from_checkpoint(saved: dict | None) -> ExecutionPlan:
    if saved is None:
        raise ResumeFailedError("The paused run's saved state is missing, so it can't continue.")
    try:
        return compile_flow(Flow.model_validate(saved["flow"]), saved["trigger_id"])
    except (ApiError, ValueError) as exc:
        # E.g. the node catalog changed since the run paused.
        raise ResumeFailedError(f"The paused run can't continue: {exc}") from exc


@router.get("/approvals")
async def list_approvals(user: CurrentUser, runs: Runs) -> list[PendingApprovalItem]:
    """Everything waiting for the caller's approval, across their flows (oldest first)."""
    return await runs.list_pending_approvals(user.uid)


@router.get("/flows/{flow_id}/runs")
async def list_runs(
    flow_id: FlowId,
    user: CurrentUser,
    flows: FlowRepo,
    runs: Runs,
    manager: Manager,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
) -> list[RunSummary]:
    """The flow's latest runs, newest first."""
    await flows.get(user.uid, flow_id)  # 404 unless it's the caller's flow
    return await runs.list_for_flow(user.uid, flow_id, limit=limit, live=manager.is_live)


@router.get("/runs/{run_id}")
async def get_run(run_id: RunId, user: CurrentUser, runs: Runs, manager: Manager) -> RunInfo:
    return await runs.get(user.uid, run_id, live=manager.is_live(run_id))


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: RunId, user: CurrentUser, runs: Runs, manager: Manager) -> RunInfo:
    """Stops the run if it's still going or waiting for approval; returns its record."""
    live = manager.get(run_id)
    if live is not None and live.owner_uid == user.uid and not live.finished:
        await manager.cancel(run_id)
    else:
        await runs.cancel_paused(user.uid, run_id)  # 404 for others' runs; no-op if not paused
    return await runs.get(user.uid, run_id, live=manager.is_live(run_id))


def _sse(event: dict) -> str:
    data = json.dumps(event, ensure_ascii=False, default=str)
    lines = [f"event: {event['type']}", f"data: {data}"]
    if "seq" in event:
        lines.insert(0, f"id: {event['seq']}")
    return "\n".join(lines) + "\n\n"


@router.get("/runs/{run_id}/stream")
async def stream_run(
    run_id: RunId,
    user: CurrentUser,
    runs: Runs,
    manager: Manager,
    last_event_id: Annotated[str | None, Header()] = None,
) -> StreamingResponse:
    live = manager.get(run_id)
    if live is not None and live.owner_uid == user.uid:
        after = int(last_event_id) if last_event_id and last_event_id.isdigit() else 0

        async def follow() -> AsyncIterator[str]:
            async for event in live.log.follow(after):
                yield ": ping\n\n" if event is None else _sse(event)

        body = follow()
    else:
        info = await runs.get(user.uid, run_id, live=False)  # 404 for others' runs

        async def snapshot() -> AsyncIterator[str]:
            yield _sse({"type": "snapshot", "run": info.model_dump(mode="json")})

        body = snapshot()
    return StreamingResponse(
        body,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
