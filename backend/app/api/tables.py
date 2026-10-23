"""The caller's tables (written by the Write to Table node; app/repositories/tables.py).

    GET    /tables                              most recently written first
    GET    /tables/{table_id}
    GET    /tables/{table_id}/rows?limit=100    most recently written first
    DELETE /tables/{table_id}                   with all its rows
    DELETE /tables/{table_id}/rows/{row_id}

Others' tables → 404 `table_not_found`. Tables are created by flows, not here.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.core.auth import CurrentUser
from app.core.firebase import get_db
from app.repositories.tables import TableRepository
from app.schemas.tables import MAX_ROW_ID, RowInfo, TableInfo

router = APIRouter(prefix="/tables", tags=["tables"])


def get_table_repository() -> TableRepository:
    return TableRepository(get_db())


Repo = Annotated[TableRepository, Depends(get_table_repository)]
TableId = Annotated[str, Path(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")]
RowId = Annotated[str, Path(min_length=1, max_length=MAX_ROW_ID)]


@router.get("")
async def list_tables(user: CurrentUser, repo: Repo) -> list[TableInfo]:
    return await repo.list(user.uid)


@router.get("/{table_id}")
async def get_table(table_id: TableId, user: CurrentUser, repo: Repo) -> TableInfo:
    return await repo.get(user.uid, table_id)


@router.get("/{table_id}/rows")
async def list_rows(
    table_id: TableId,
    user: CurrentUser,
    repo: Repo,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> list[RowInfo]:
    return await repo.rows(user.uid, table_id, limit)


@router.delete("/{table_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_table(table_id: TableId, user: CurrentUser, repo: Repo) -> Response:
    await repo.delete(user.uid, table_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/{table_id}/rows/{row_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_row(table_id: TableId, row_id: RowId, user: CurrentUser, repo: Repo) -> Response:
    await repo.delete_row(user.uid, table_id, row_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
