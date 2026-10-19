"""Firestore persistence for schedules: one `schedules/{id}` document per Schedule trigger of a
saved flow, kept in step with the flow by `app/services/schedules.py`.

Document `schedules/{flow_id}--{hash of node_id}`:
    owner_uid, flow_id, node_id, cron, timezone, enabled,
    next_run_at   when it fires next (None: not scheduled — off, or `problem`)
    problem       why it can't be scheduled (bad cron / timezone, the flow has problems)
    last_fired_at, last_run_id, last_error (the latest time it was due, and what happened)
    updated_at

The scheduler finds due schedules with a `next_run_at <= now` query (single-field index) and
claims each with a conditional write, so a time fires once even with several backend instances.
"""

import hashlib
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from google.api_core.exceptions import FailedPrecondition, NotFound
from google.cloud import firestore
from google.cloud.firestore_v1 import FieldFilter

COLLECTION = "schedules"
#: What `sync` compares to decide whether a schedule changed.
DEFINITION = ("owner_uid", "flow_id", "node_id", "cron", "timezone", "enabled", "problem")


def schedule_id(flow_id: str, node_id: str) -> str:
    # Node ids are free-form (imported flows); document ids can't contain "/".
    return f"{flow_id}--{hashlib.sha256(node_id.encode()).hexdigest()[:16]}"


@dataclass
class Schedule:
    id: str
    owner_uid: str
    flow_id: str
    node_id: str
    cron: str
    timezone: str
    enabled: bool
    next_run_at: datetime | None = None
    problem: str | None = None
    last_fired_at: datetime | None = None
    last_run_id: str | None = None
    last_error: str | None = None

    @classmethod
    def from_snapshot(cls, snapshot: Any) -> "Schedule":
        data = snapshot.to_dict()
        fields = cls.__dataclass_fields__
        return cls(id=snapshot.id, **{k: v for k, v in data.items() if k in fields})


class ScheduleRepository:
    def __init__(self, db: firestore.AsyncClient) -> None:
        self._db = db
        self._collection = db.collection(COLLECTION)

    async def _of_flow(self, flow_id: str) -> list[Schedule]:
        query = self._collection.where(filter=FieldFilter("flow_id", "==", flow_id))
        return [Schedule.from_snapshot(s) async for s in query.stream()]

    async def list_for_flow(self, owner_uid: str, flow_id: str) -> list[Schedule]:
        return [s for s in await self._of_flow(flow_id) if s.owner_uid == owner_uid]

    async def replace_for_flow(self, flow_id: str, wanted: list[dict[str, Any]]) -> None:
        """Makes the flow's schedules exactly `wanted` (dicts with the DEFINITION fields plus
        `next_run_at`). Unchanged ones aren't written (flows are autosaved often) and keep their
        `next_run_at`; changed ones keep their `last_*` fields."""
        existing = {s.id: s for s in await self._of_flow(flow_id)}
        batch = self._db.batch()
        writes = 0
        for schedule in wanted:
            id_ = schedule_id(flow_id, schedule["node_id"])
            current = existing.pop(id_, None)
            if current is not None and all(getattr(current, k) == schedule[k] for k in DEFINITION):
                continue
            batch.set(
                self._collection.document(id_),
                {**schedule, "updated_at": firestore.SERVER_TIMESTAMP},
                merge=True,
            )
            writes += 1
        for id_ in existing:
            batch.delete(self._collection.document(id_))
            writes += 1
        if writes:
            await batch.commit()

    async def delete_for_flow(self, flow_id: str) -> None:
        for schedule in await self._of_flow(flow_id):
            await self._collection.document(schedule.id).delete()

    async def delete(self, id_: str) -> None:
        await self._collection.document(id_).delete()

    async def due(self, now: datetime, limit: int = 100) -> list[Schedule]:
        query = (
            self._collection.where(filter=FieldFilter("next_run_at", "<=", now))
            .order_by("next_run_at")
            .limit(limit)
        )
        return [Schedule.from_snapshot(s) async for s in query.stream()]

    async def claim(self, id_: str, due_at: datetime, next_run_at: datetime) -> bool:
        """Moves a schedule due at `due_at` on to `next_run_at` — unless someone else did first
        (another instance, or a save that changed it). True when this call claimed it.
        Optimistic: the write only succeeds if the document is unchanged since it was read (a
        transaction would lock it, and two claims at once can deadlock until both give up)."""
        ref = self._collection.document(id_)
        snapshot = await ref.get()
        if not snapshot.exists or snapshot.get("next_run_at") != due_at:
            return False
        try:
            await ref.update(
                {"next_run_at": next_run_at, "last_fired_at": due_at},
                option=self._db.write_option(last_update_time=snapshot.update_time),
            )
        except FailedPrecondition:
            return False
        return True

    async def record(self, id_: str, fields: dict[str, Any]) -> None:
        try:
            await self._collection.document(id_).update(fields)
        except NotFound:
            pass  # deleted meanwhile (the flow was deleted or the trigger removed)
