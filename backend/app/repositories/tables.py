"""Firestore persistence for tables. Every method is scoped to the owner's uid.

    tables/{owner_uid}--{hash of the name, case-insensitive}
        owner_uid, name (as first written), row_count, created_at, updated_at
    tables/{table_id}/rows/{row_id}
        data_json (the row as JSON text: Firestore can't nest arrays, and it's never queried),
        created_at, updated_at, flow_id, run_id (what wrote it last)

`row_count` moves with `Increment` in the same batch as the row, not in a transaction: parallel
writes to one table would contend (the emulator even deadlocks), and the limits it enforces
(MAX_ROWS_PER_TABLE) can tolerate a few rows too many.
"""

from __future__ import annotations  # the `list` method shadows the builtin in annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from google.api_core.exceptions import Conflict
from google.cloud import firestore
from google.cloud.firestore_v1 import FieldFilter

from app.core.errors import ApiError, ConflictError, NotFoundError
from app.schemas.tables import (
    MAX_ROW_CHARS,
    MAX_ROWS_PER_TABLE,
    MAX_TABLES_PER_USER,
    RowInfo,
    TableInfo,
)

COLLECTION = "tables"
DELETE_BATCH = 400


class TableNotFoundError(NotFoundError):
    code = "table_not_found"
    message = "Table not found."


class RowNotFoundError(NotFoundError):
    code = "row_not_found"
    message = "Row not found."


class TooManyTablesError(ConflictError):
    code = "too_many_tables"
    message = f"You can have up to {MAX_TABLES_PER_USER} tables. Delete one first."


class TableFullError(ConflictError):
    code = "table_full"
    message = f"A table can hold up to {MAX_ROWS_PER_TABLE:,} rows. Delete some first."


class RowTooLargeError(ApiError):
    status_code = 413
    code = "row_too_large"
    message = f"The row is too large (at most {MAX_ROW_CHARS:,} characters of JSON)."


def table_id(owner_uid: str, name: str) -> str:
    key = hashlib.sha256(name.casefold().encode()).hexdigest()[:16]
    return f"{owner_uid}--{key}"


def _table(snapshot: Any) -> TableInfo:
    data = snapshot.to_dict()
    return TableInfo(
        table_id=snapshot.id,
        name=data["name"],
        row_count=max(data.get("row_count", 0), 0),
        created_at=data["created_at"],
        updated_at=data["updated_at"],
    )


def _row(snapshot: Any) -> RowInfo:
    data = snapshot.to_dict()
    return RowInfo(
        row_id=snapshot.id,
        data=json.loads(data["data_json"]),
        created_at=data["created_at"],
        updated_at=data["updated_at"],
        flow_id=data.get("flow_id"),
        run_id=data.get("run_id"),
    )


class TableRepository:
    def __init__(self, db: firestore.AsyncClient) -> None:
        self._db = db
        self._collection = db.collection(COLLECTION)

    def _owned_query(self, owner_uid: str) -> Any:
        return self._collection.where(filter=FieldFilter("owner_uid", "==", owner_uid))

    async def _owned_snapshot(self, owner_uid: str, id_: str) -> Any:
        snapshot = await self._collection.document(id_).get()
        if not snapshot.exists or snapshot.get("owner_uid") != owner_uid:
            raise TableNotFoundError()
        return snapshot

    async def list(self, owner_uid: str) -> list[TableInfo]:
        """Most recently written first (at most MAX_TABLES_PER_USER: sorted here)."""
        tables = [_table(s) async for s in self._owned_query(owner_uid).stream()]
        return sorted(tables, key=lambda t: t.updated_at, reverse=True)

    async def get(self, owner_uid: str, id_: str) -> TableInfo:
        return _table(await self._owned_snapshot(owner_uid, id_))

    async def rows(self, owner_uid: str, id_: str, limit: int) -> list[RowInfo]:
        """The most recently written rows first."""
        await self._owned_snapshot(owner_uid, id_)
        query = (
            self._collection.document(id_)
            .collection("rows")
            .order_by("updated_at", direction=firestore.Query.DESCENDING)
            .limit(limit)
        )
        return [_row(s) async for s in query.stream()]

    async def write_row(
        self,
        owner_uid: str,
        name: str,
        row: dict[str, Any],
        *,
        row_id: str | None,
        merge: bool,
        flow_id: str | None,
        run_id: str | None,
    ) -> tuple[TableInfo, str, bool, dict[str, Any]]:
        """Adds a row (no `row_id`) or writes row `row_id` — replaced, or with `merge` its other
        fields kept. Creates the table on first use.
        Returns (table, row id, created, the row as stored)."""
        now = datetime.now(UTC)
        ref = self._collection.document(table_id(owner_uid, name))
        snapshot = await ref.get()
        if not snapshot.exists:
            count = await self._owned_query(owner_uid).count().get()
            if count[0][0].value >= MAX_TABLES_PER_USER:
                raise TooManyTablesError()
            fields = {"owner_uid": owner_uid, "name": name, "row_count": 0}
            try:
                await ref.create({**fields, "created_at": now, "updated_at": now})
            except Conflict:
                pass  # created meanwhile by a parallel write
            snapshot = await ref.get()
        rows = ref.collection("rows")
        row_ref = rows.document(row_id) if row_id else rows.document()
        return await self._write(snapshot, row_ref, row, merge, flow_id, run_id, now)

    async def _write(
        self,
        table: Any,
        row_ref: Any,
        row: dict[str, Any],
        merge: bool,
        flow_id: str | None,
        run_id: str | None,
        now: datetime,
        retried: bool = False,
    ) -> tuple[TableInfo, str, bool, dict[str, Any]]:
        existing = await row_ref.get()
        stored = row
        if existing.exists and merge:
            stored = {**json.loads(existing.get("data_json")), **row}
        text = json.dumps(stored, ensure_ascii=False)
        if len(text) > MAX_ROW_CHARS:
            raise RowTooLargeError()
        fields = {"data_json": text, "updated_at": now, "flow_id": flow_id, "run_id": run_id}
        batch = self._db.batch()
        if existing.exists:
            batch.update(row_ref, fields)
            batch.update(table.reference, {"updated_at": now})
        else:
            if table.get("row_count") >= MAX_ROWS_PER_TABLE:
                raise TableFullError()
            batch.create(row_ref, {**fields, "created_at": now})
            batch.update(table.reference, {"row_count": firestore.Increment(1), "updated_at": now})
        try:
            await batch.commit()
        except Conflict:
            if retried:
                raise
            # The same new row id written in parallel: write it again as an existing row.
            return await self._write(table, row_ref, row, merge, flow_id, run_id, now, True)
        info = _table(await table.reference.get())
        return info, row_ref.id, not existing.exists, stored

    async def delete(self, owner_uid: str, id_: str) -> None:
        snapshot = await self._owned_snapshot(owner_uid, id_)
        rows = snapshot.reference.collection("rows")
        while True:
            batch_rows = [s async for s in rows.limit(DELETE_BATCH).stream()]
            if not batch_rows:
                break
            batch = self._db.batch()
            for s in batch_rows:
                batch.delete(s.reference)
            await batch.commit()
        await snapshot.reference.delete()

    async def delete_row(self, owner_uid: str, id_: str, row_id: str) -> None:
        snapshot = await self._owned_snapshot(owner_uid, id_)
        row_ref = snapshot.reference.collection("rows").document(row_id)
        if not (await row_ref.get()).exists:
            raise RowNotFoundError()
        batch = self._db.batch()
        batch.delete(row_ref)
        batch.update(
            snapshot.reference,
            {"row_count": firestore.Increment(-1), "updated_at": datetime.now(UTC)},
        )
        await batch.commit()
