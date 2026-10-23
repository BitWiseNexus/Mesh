"""Starting runs: what the Run button, webhooks and schedules share."""

import json
from typing import Any

from app.core.config import get_settings
from app.core.errors import ApiError
from app.core.firebase import get_db
from app.engine.compiler import ExecutionPlan
from app.engine.executor import not_runnable_issues
from app.engine.validation import FlowIssue
from app.repositories.chunks import ChunkRepository
from app.repositories.credentials import CredentialRepository
from app.repositories.knowledge import KnowledgeBaseRepository
from app.repositories.runs import RunRepository
from app.repositories.tables import TableRepository
from app.schemas.flow import Flow
from app.schemas.flows_api import StoredFlow
from app.schemas.runs import RunInfo
from app.services.credentials import UserSecrets
from app.services.ingestion import IngestionManager
from app.services.knowledge import UserKnowledge
from app.services.runs import RunManager
from app.services.tables import UserTables


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


def owner_services(owner_uid: str, ingestion: IngestionManager) -> dict[str, Any]:
    """What a run needs of its owner's account: saved API keys, knowledge bases and tables."""
    db = get_db()
    secrets = UserSecrets(CredentialRepository(db), owner_uid)
    knowledge = UserKnowledge(
        KnowledgeBaseRepository(db), ChunkRepository(db), owner_uid, secrets, ingestion
    )
    tables = UserTables(TableRepository(db), owner_uid)
    return {"secrets": secrets, "knowledge": knowledge, "tables": tables}


#: Run records keep at most this much of a run's input (as text; webhook requests as JSON).
MAX_RECORDED_INPUT = 100_000


async def launch_run(
    *,
    owner_uid: str,
    stored: StoredFlow,
    plan: ExecutionPlan,
    input: Any,
    runs: RunRepository,
    manager: RunManager,
    ingestion: IngestionManager,
) -> RunInfo:
    """Starts `plan` (compiled from `stored`) as its owner — the one way runs start
    (Run button, webhooks, schedules).
    422 `nodes_not_runnable`, 429 `too_many_runs`."""
    if issues := not_runnable_issues(plan):
        raise NodesNotRunnableError(issues)
    if manager.active_runs(owner_uid) >= get_settings().max_active_runs_per_user:
        raise TooManyRunsError()
    recorded = input
    if input is not None and not isinstance(input, str):
        recorded = json.dumps(input, ensure_ascii=False, default=str)[:MAX_RECORDED_INPUT]
    info = await runs.create(
        owner_uid=owner_uid,
        flow_id=stored.flow_id,
        flow_name=stored.name,
        flow_version=stored.version,
        trigger_id=plan.trigger_id,
        input=recorded,
    )
    manager.start(
        run_id=info.run_id,
        owner_uid=owner_uid,
        plan=plan,
        input=input,
        repository=runs,
        **owner_services(owner_uid, ingestion),
        # Kept with the checkpoint if the run pauses: it resumes the flow as it was run.
        flow_snapshot=Flow.model_validate(stored.model_dump()).model_dump(mode="json"),
    )
    return info
