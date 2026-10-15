"""Firestore persistence for runs (context.md D2: status transitions and outputs, never tokens).

Document `runs/{run_id}`:
    owner_uid, flow_id, flow_name, flow_version, status, trigger_id, input, error,
    created_at, started_at, finished_at,
    pending_approvals: {node_id: {message, content_json, content_truncated, allow_edit,
                                  requested_at}}          (Approval Gates waiting; status paused)
    node_states: {node_id: {status, started_at, finished_at, error, handles,
                            output_json, output_truncated, calls, iteration}}
                 (a tool node's entry is its latest call; `calls` counts them)

Outputs are stored as JSON text (`output_json`): Firestore can't hold arrays inside arrays, and
indexing arbitrary output would waste writes (`node_states` is exempt from indexing). Each output
is capped, and so is their total, to stay well below Firestore's 1 MiB document limit; a capped
output keeps a text preview and `output_truncated: true`.

A paused run's checkpoint (everything needed to resume, incl. the flow as it was) lives in
`runs/{run_id}/state/checkpoint` as zlib-compressed JSON bytes — not readable by clients (rules
default-deny), and outside the run document so its size doesn't count against it.
"""

import asyncio
import json
import logging
import zlib
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from google.cloud import firestore
from google.cloud.firestore_v1 import FieldFilter
from google.cloud.firestore_v1.field_path import FieldPath

from app.core.errors import ApiError, ConflictError, NotFoundError
from app.engine.events import SETTLED_RUN_STATUSES, RunEvent
from app.schemas.runs import NodeRunState, PendingApproval, PendingApprovalItem, RunInfo, RunSummary

logger = logging.getLogger(__name__)

COLLECTION = "runs"
#: Characters of one node's output kept in the run document.
OUTPUT_MAX_CHARS = 20_000
#: Characters of output kept per run in total.
RUN_OUTPUT_BUDGET = 600_000
INTERRUPTED = "The run was interrupted because the server restarted."
SUMMARY_FIELDS = [
    "flow_name",
    "flow_version",
    "status",
    "trigger_id",
    "error",
    "created_at",
    "started_at",
    "finished_at",
]
#: Deletes per Firestore batch (the limit is 500 writes; each run can take two).
DELETE_BATCH = 200
#: Compressed checkpoint size limit (a Firestore document holds at most 1 MiB).
MAX_CHECKPOINT_BYTES = 950_000


class RunNotFoundError(NotFoundError):
    code = "run_not_found"
    message = "Run not found."


class RunNotPausedError(ConflictError):
    code = "run_not_paused"
    message = "This run isn't waiting for an approval (it may have been answered already)."


class ApprovalNotFoundError(NotFoundError):
    code = "approval_not_found"
    message = "That step isn't waiting for an approval."


class EditNotAllowedError(ApiError):
    status_code = 422
    code = "edit_not_allowed"
    message = "This Approval Gate doesn't let reviewers change the content."


class CheckpointTooLargeError(Exception):
    """The run's state is too big to save while it waits."""


def _encode_content(content: Any) -> dict[str, Any]:
    encoded = json.dumps(content, ensure_ascii=False, default=str)
    if len(encoded) <= OUTPUT_MAX_CHARS:
        return {"content_json": encoded, "content_truncated": False}
    preview = content if isinstance(content, str) else encoded
    return {"content_json": preview[:OUTPUT_MAX_CHARS], "content_truncated": True}


def _pending(raw: dict[str, Any] | None) -> list[PendingApproval]:
    items = []
    for node_id, entry in (raw or {}).items():
        encoded = entry.get("content_json")
        truncated = entry.get("content_truncated", False)
        content = encoded if truncated or encoded is None else json.loads(encoded)
        items.append(
            PendingApproval(
                node_id=node_id,
                message=entry.get("message", ""),
                content=content,
                content_truncated=truncated,
                allow_edit=entry.get("allow_edit", False),
                requested_at=entry["requested_at"],
            )
        )
    return sorted(items, key=lambda a: a.requested_at)


def _node_state(raw: dict[str, Any]) -> NodeRunState:
    output: Any = None
    if (encoded := raw.get("output_json")) is not None:
        output = encoded if raw.get("output_truncated") else json.loads(encoded)
    return NodeRunState(
        status=raw["status"],
        started_at=raw.get("started_at"),
        finished_at=raw.get("finished_at"),
        output=output,
        output_truncated=raw.get("output_truncated", False),
        error=raw.get("error"),
        handles=raw.get("handles"),
        calls=raw.get("calls"),
        iteration=raw.get("iteration"),
    )


def _to_info(run_id: str, data: dict[str, Any]) -> RunInfo:
    return RunInfo(
        run_id=run_id,
        flow_id=data["flow_id"],
        flow_name=data.get("flow_name", ""),
        flow_version=data["flow_version"],
        status=data["status"],
        trigger_id=data["trigger_id"],
        input=data.get("input"),
        error=data.get("error"),
        created_at=data["created_at"],
        started_at=data.get("started_at"),
        finished_at=data.get("finished_at"),
        node_states={k: _node_state(v) for k, v in (data.get("node_states") or {}).items()},
        pending_approvals=_pending(data.get("pending_approvals")),
    )


class RunRepository:
    def __init__(self, db: firestore.AsyncClient) -> None:
        self._db = db
        self._collection = db.collection(COLLECTION)

    def _flow_query(self, owner_uid: str, flow_id: str) -> Any:
        return self._collection.where(filter=FieldFilter("owner_uid", "==", owner_uid)).where(
            filter=FieldFilter("flow_id", "==", flow_id)
        )

    async def list_for_flow(
        self, owner_uid: str, flow_id: str, *, limit: int, live: Callable[[str], bool]
    ) -> list[RunSummary]:
        """The flow's runs, newest first. Needs the composite index (owner_uid, flow_id,
        created_at desc) in firebase/firestore.indexes.json. Runs that claim to be active but
        aren't `live` show as interrupted (they're marked so when opened, see `get`)."""
        query = (
            self._flow_query(owner_uid, flow_id)
            .order_by("created_at", direction=firestore.Query.DESCENDING)
            .select(SUMMARY_FIELDS)
            .limit(limit)
        )
        summaries = []
        async for snapshot in query.stream():
            data = snapshot.to_dict()
            if data["status"] not in SETTLED_RUN_STATUSES and not live(snapshot.id):
                data |= {"status": "failed", "error": INTERRUPTED}
            summaries.append(RunSummary(run_id=snapshot.id, **data))
        return summaries

    async def delete_for_flow(self, owner_uid: str, flow_id: str) -> int:
        """Deletes every run of the flow; returns how many."""
        deleted = 0
        while True:
            snapshots = [
                s
                async for s in self._flow_query(owner_uid, flow_id)
                .limit(DELETE_BATCH)
                .select([])
                .stream()
            ]
            if not snapshots:
                return deleted
            batch = self._db.batch()
            for snapshot in snapshots:
                batch.delete(self._checkpoint_ref(snapshot.id))
                batch.delete(snapshot.reference)
            await batch.commit()
            deleted += len(snapshots)

    async def create(
        self,
        *,
        owner_uid: str,
        flow_id: str,
        flow_version: int,
        trigger_id: str,
        input: str | None,
        flow_name: str = "",
    ) -> RunInfo:
        ref = self._collection.document()
        data = {
            "owner_uid": owner_uid,
            "flow_id": flow_id,
            "flow_name": flow_name,
            "flow_version": flow_version,
            "status": "queued",
            "trigger_id": trigger_id,
            "input": input,
            "error": None,
            "created_at": datetime.now(UTC),
            "started_at": None,
            "finished_at": None,
            "node_states": {},
            "pending_approvals": {},
        }
        await ref.create(data)
        return _to_info(ref.id, data)

    async def update(self, run_id: str, fields: dict[str, Any]) -> None:
        await self._collection.document(run_id).update(fields)

    async def get(self, owner_uid: str, run_id: str, *, live: bool) -> RunInfo:
        """The caller's run. `live`: whether this process is executing it — a run that claims to
        be active but isn't live was cut off by a restart, and is marked as failed."""
        snapshot = await self._collection.document(run_id).get()
        # Someone else's run is reported exactly like a missing one.
        if not snapshot.exists or snapshot.get("owner_uid") != owner_uid:
            raise RunNotFoundError()
        data = snapshot.to_dict()
        if not live and data["status"] not in SETTLED_RUN_STATUSES:
            fields = {"status": "failed", "error": INTERRUPTED, "finished_at": datetime.now(UTC)}
            await self.update(run_id, fields)
            data |= fields
        return _to_info(run_id, data)

    # ── Paused runs ─────────────────────────────────────────────────────────

    def _checkpoint_ref(self, run_id: str) -> Any:
        return self._collection.document(run_id).collection("state").document("checkpoint")

    async def save_checkpoint(self, run_id: str, checkpoint: dict[str, Any]) -> None:
        data = zlib.compress(json.dumps(checkpoint, ensure_ascii=False, default=str).encode())
        if len(data) > MAX_CHECKPOINT_BYTES:
            raise CheckpointTooLargeError(
                f"the run's state is {len(data) // 1000} kB compressed (at most "
                f"{MAX_CHECKPOINT_BYTES // 1000} kB can be kept while it waits)"
            )
        await self._checkpoint_ref(run_id).set({"data": data, "saved_at": datetime.now(UTC)})

    async def load_checkpoint(self, run_id: str) -> dict[str, Any] | None:
        snapshot = await self._checkpoint_ref(run_id).get()
        if not snapshot.exists:
            return None
        return json.loads(zlib.decompress(snapshot.get("data")))

    async def delete_checkpoint(self, run_id: str) -> None:
        await self._checkpoint_ref(run_id).delete()

    async def claim_for_resume(
        self, owner_uid: str, run_id: str, node_id: str, *, edited: bool
    ) -> None:
        """Atomically moves a paused run to `running` for answering `node_id`'s approval — so a
        double click or a second tab can't resume it twice."""
        ref = self._collection.document(run_id)

        @firestore.async_transactional
        async def claim(transaction: Any) -> None:
            snapshot = await ref.get(transaction=transaction)
            if not snapshot.exists or snapshot.get("owner_uid") != owner_uid:
                raise RunNotFoundError()
            data = snapshot.to_dict()
            if data["status"] != "paused":
                raise RunNotPausedError()
            request = (data.get("pending_approvals") or {}).get(node_id)
            if request is None:
                raise ApprovalNotFoundError()
            if edited and not request.get("allow_edit"):
                raise EditNotAllowedError()
            transaction.update(ref, {"status": "running"})

        await claim(self._db.transaction())

    async def cancel_paused(self, owner_uid: str, run_id: str) -> bool:
        """Stops a paused run (its approvals are dropped). False if it isn't paused."""
        ref = self._collection.document(run_id)

        @firestore.async_transactional
        async def cancel(transaction: Any) -> bool:
            snapshot = await ref.get(transaction=transaction)
            if not snapshot.exists or snapshot.get("owner_uid") != owner_uid:
                raise RunNotFoundError()
            if snapshot.get("status") != "paused":
                return False
            transaction.update(
                ref,
                {
                    "status": "cancelled",
                    "finished_at": datetime.now(UTC),
                    "pending_approvals": {},
                },
            )
            return True

        cancelled = await cancel(self._db.transaction())
        if cancelled:
            await self.delete_checkpoint(run_id)
        return cancelled

    async def list_pending_approvals(self, owner_uid: str) -> list[PendingApprovalItem]:
        """Everything waiting for the owner, oldest first (equality filters only: no composite
        index needed)."""
        query = self._collection.where(filter=FieldFilter("owner_uid", "==", owner_uid)).where(
            filter=FieldFilter("status", "==", "paused")
        )
        items: list[PendingApprovalItem] = []
        async for snapshot in query.stream():
            data = snapshot.to_dict()
            for approval in _pending(data.get("pending_approvals")):
                items.append(
                    PendingApprovalItem(
                        run_id=snapshot.id,
                        flow_id=data["flow_id"],
                        flow_name=data.get("flow_name", ""),
                        node_id=approval.node_id,
                        message=approval.message,
                        requested_at=approval.requested_at,
                    )
                )
        return sorted(items, key=lambda i: i.requested_at)


class RunRecorder:
    """Persists a run's events as they happen. `record` never blocks the runner: updates are
    merged in memory and written by one background task, in order; `close` flushes them."""

    def __init__(self, repository: RunRepository, run_id: str) -> None:
        self._repository = repository
        self._run_id = run_id
        self._nodes: dict[str, dict[str, Any]] = {}
        self._pending: dict[str, Any] = {}
        self._output_budget = RUN_OUTPUT_BUDGET
        #: Characters of each node's stored output (given back when it's replaced).
        self._output_sizes: dict[str, int] = {}
        self._wake = asyncio.Event()
        self._closing = False
        self._worker = asyncio.create_task(self._write_loop(), name=f"run-recorder:{run_id}")

    def record(self, event: RunEvent) -> None:
        kind = event["type"]
        at = datetime.fromisoformat(event["at"])
        if kind == "run_started":
            self._pending |= {"status": "running", "started_at": at}
        elif kind == "node_started":
            # A node in a loop starts again: its entry describes the latest pass.
            self._release_output(event["node_id"])
            state: dict[str, Any] = {"status": "running", "started_at": at}
            if event.get("iteration"):
                state["iteration"] = event["iteration"]
            self._set_node(event["node_id"], state)
        elif kind == "node_finished":
            state = {**self._nodes.get(event["node_id"], {}), "status": event["status"]}
            state["finished_at"] = at
            if event.get("error"):
                state["error"] = event["error"]
            if event["status"] == "succeeded":
                state["handles"] = event.get("handles", [])
                state |= self._encode_output(event["node_id"], event.get("output"))
            self._set_node(event["node_id"], state)
        elif kind == "tool_call":
            # A tool node's state is its latest call (+ how many calls it got).
            if not event["tool_node_id"]:
                return  # the model called a tool that doesn't exist
            previous = self._nodes.get(event["tool_node_id"], {})
            self._release_output(event["tool_node_id"])
            self._set_node(
                event["tool_node_id"],
                {"status": "running", "started_at": at, "calls": previous.get("calls", 0) + 1},
            )
        elif kind == "tool_result":
            if not event["tool_node_id"]:
                return
            state = {**self._nodes.get(event["tool_node_id"], {}), "status": event["status"]}
            state["finished_at"] = at
            state.pop("output_json", None)
            state.pop("error", None)
            if event.get("error"):
                state["error"] = event["error"]
            else:
                state |= self._encode_output(event["tool_node_id"], event.get("output"))
            self._set_node(event["tool_node_id"], state)
        elif kind == "approval_requested":
            node_id = event["node_id"]
            self._set_node(node_id, {**self._nodes.get(node_id, {}), "status": "waiting"})
            self._pending[FieldPath("pending_approvals", node_id).to_api_repr()] = {
                "message": event.get("message", ""),
                "allow_edit": event.get("allow_edit", False),
                "requested_at": at,
                **_encode_content(event.get("content")),
            }
        elif kind == "approval_decided":
            path = FieldPath("pending_approvals", event["node_id"]).to_api_repr()
            self._pending[path] = firestore.DELETE_FIELD
        elif kind == "run_paused":
            self._pending |= {"status": "paused"}
        elif kind == "run_resumed":
            self._pending |= {"status": "running", "error": None, "finished_at": None}
        elif kind == "run_finished":
            # Firestore rejects writing a field and one of its subfields in the same update.
            for key in [k for k in self._pending if k.startswith("pending_approvals.")]:
                del self._pending[key]
            self._pending |= {
                "status": event["status"],
                "error": event.get("error"),
                "finished_at": at,
                # A run that stops while gates wait (failure elsewhere, Stop) drops them.
                "pending_approvals": {},
            }
        else:
            return  # tokens and logs are stream-only
        self._wake.set()

    def _set_node(self, node_id: str, state: dict[str, Any]) -> None:
        self._nodes[node_id] = state
        # The whole entry, so a later write of the same node simply replaces it.
        self._pending[FieldPath("node_states", node_id).to_api_repr()] = state

    def _release_output(self, node_id: str) -> None:
        self._output_budget += self._output_sizes.pop(node_id, 0)

    def _encode_output(self, node_id: str, output: Any) -> dict[str, Any]:
        self._release_output(node_id)
        encoded = json.dumps(output, ensure_ascii=False, default=str)
        limit = min(OUTPUT_MAX_CHARS, self._output_budget)
        if len(encoded) <= limit:
            stored, truncated = encoded, False
        else:
            preview = output if isinstance(output, str) else encoded
            stored, truncated = preview[: max(limit, 0)], True
        self._output_budget -= len(stored)
        self._output_sizes[node_id] = len(stored)
        return {"output_json": stored, "output_truncated": truncated}

    async def _write_loop(self) -> None:
        while True:
            await self._wake.wait()
            self._wake.clear()
            while self._pending:
                batch, self._pending = self._pending, {}
                await self._write(batch)
            if self._closing:
                return

    async def _write(self, batch: dict[str, Any], attempts: int = 3) -> None:
        for attempt in range(attempts):
            try:
                await self._repository.update(self._run_id, batch)
                return
            except Exception:
                logger.exception("Couldn't record run %s (attempt %d)", self._run_id, attempt + 1)
                await asyncio.sleep(0.5 * 2**attempt)
        # Give up on this batch; later writes replace whole node entries, so they still converge.

    async def close(self) -> None:
        self._closing = True
        self._wake.set()
        await self._worker
