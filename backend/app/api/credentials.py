"""Saved API keys: list / add / rename or replace / delete. Values are write-only."""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response, status

from app.core.auth import CurrentUser
from app.core.firebase import get_db
from app.repositories.credentials import CredentialRepository
from app.schemas.credentials import CredentialCreate, CredentialInfo, CredentialUpdate

router = APIRouter(prefix="/credentials", tags=["credentials"])


def get_credential_repository() -> CredentialRepository:
    return CredentialRepository(get_db())


Repo = Annotated[CredentialRepository, Depends(get_credential_repository)]
CredentialId = Annotated[str, Path(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")]


@router.get("")
async def list_credentials(user: CurrentUser, repo: Repo) -> list[CredentialInfo]:
    """The caller's keys, newest first (names and hints only)."""
    return await repo.list(user.uid)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_credential(
    body: CredentialCreate, user: CurrentUser, repo: Repo
) -> CredentialInfo:
    """409 `too_many_credentials` beyond 50."""
    return await repo.create(user.uid, body)


@router.patch("/{credential_id}")
async def update_credential(
    credential_id: CredentialId, body: CredentialUpdate, user: CurrentUser, repo: Repo
) -> CredentialInfo:
    """Renames and/or replaces the key's value."""
    return await repo.update(user.uid, credential_id, body)


@router.delete("/{credential_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_credential(credential_id: CredentialId, user: CurrentUser, repo: Repo) -> Response:
    await repo.delete(user.uid, credential_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
