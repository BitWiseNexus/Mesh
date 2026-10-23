"""A run's access to its owner's tables (the `Tables` protocol in app/engine/context.py)."""

from typing import Any

from app.core.errors import ApiError
from app.engine.executor import NodeError
from app.repositories.tables import TableRepository
from app.schemas.tables import clean_row_id, clean_table_name


class UserTables:
    def __init__(self, repository: TableRepository, owner_uid: str) -> None:
        self._repository = repository
        self._owner_uid = owner_uid

    async def write_row(
        self,
        table: str,
        row: dict[str, Any],
        *,
        row_id: str | None,
        merge: bool,
        flow_id: str | None,
        run_id: str,
    ) -> dict[str, Any]:
        try:
            name = clean_table_name(table)
            row_id = clean_row_id(row_id) if row_id else None
        except ValueError as exc:
            raise NodeError(str(exc)) from None
        try:
            info, written_id, created, stored = await self._repository.write_row(
                self._owner_uid,
                name,
                row,
                row_id=row_id or None,
                merge=merge,
                flow_id=flow_id,
                run_id=run_id,
            )
        except ApiError as exc:
            raise NodeError(exc.message) from None
        return {
            "table": info.name,
            "table_id": info.table_id,
            "row_id": written_id,
            "created": created,
            "row": stored,
        }
