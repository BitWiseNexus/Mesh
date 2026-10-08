from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response, status

from app.core.auth import CurrentUser
from app.core.firebase import get_db
from app.repositories.flows import FlowRepository
from app.schemas.flow import Flow
from app.schemas.flows_api import FlowMetaUpdate, FlowSummary, FlowUpdate, StoredFlow

router = APIRouter(prefix="/flows", tags=["flows"])


def get_flow_repository() -> FlowRepository:
    return FlowRepository(get_db())


Repo = Annotated[FlowRepository, Depends(get_flow_repository)]
# Firestore auto-ids are 20 alphanumerics; the pattern also blocks reserved ids like "__x__".
FlowId = Annotated[str, Path(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")]


@router.get("")
async def list_flows(user: CurrentUser, repo: Repo) -> list[FlowSummary]:
    """The caller's flows, most recently updated first."""
    return await repo.list(user.uid)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_flow(flow: Flow, user: CurrentUser, repo: Repo) -> StoredFlow:
    return await repo.create(user.uid, flow)


@router.get("/{flow_id}")
async def get_flow(flow_id: FlowId, user: CurrentUser, repo: Repo) -> StoredFlow:
    return await repo.get(user.uid, flow_id)


@router.put("/{flow_id}")
async def replace_flow(
    flow_id: FlowId, body: FlowUpdate, user: CurrentUser, repo: Repo
) -> StoredFlow:
    """Replaces name, description and graph. Send `expected_version` to avoid overwriting a
    newer save (409 `version_conflict`)."""
    return await repo.replace(user.uid, flow_id, body, body.expected_version)


@router.patch("/{flow_id}")
async def update_flow_meta(
    flow_id: FlowId, body: FlowMetaUpdate, user: CurrentUser, repo: Repo
) -> StoredFlow:
    """Renames / re-describes a flow without touching its graph."""
    return await repo.update_meta(
        user.uid,
        flow_id,
        name=body.name,
        description=body.description,
        expected_version=body.expected_version,
    )


@router.delete("/{flow_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_flow(flow_id: FlowId, user: CurrentUser, repo: Repo) -> Response:
    await repo.delete(user.uid, flow_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{flow_id}/duplicate", status_code=status.HTTP_201_CREATED)
async def duplicate_flow(flow_id: FlowId, user: CurrentUser, repo: Repo) -> StoredFlow:
    return await repo.duplicate(user.uid, flow_id)
