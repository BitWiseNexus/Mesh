"""Firestore persistence for runs (context.md D2: status transitions and outputs, never tokens).

Document `runs/{run_id}`:
    owner_uid, flow_id, flow_version, status, trigger_id, input, error,
    created_at, started_at, finished_at,
    node_states: {node_id: {status, started_at, finished_at, error, handles,
                            output_json, output_truncated}}

Outputs are stored as JSON text (`output_json`): Firestore can't hold arrays inside arrays, and
indexing arbitrary output would waste writes (`node_states` is exempt from indexing). Each output
is capped, and so is their total, to stay well below Firestore's 1 MiB document limit; a capped
output keeps a text preview and `output_truncated: true`.
"""

import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Any

from google.cloud import firestore
from google.cloud.firestore_v1.field_path import FieldPath

from app.core.errors import NotFoundError
from app.engine.events import FINISHED_RUN_STATUSES, RunEvent
from app.schemas.runs import NodeRunState, RunInfo

logger = logging.getLogger(__name__)

COLLECTION = "runs"
#: Characters of one node's output kept in the run document.
OUTPUT_MAX_CHARS = 20_000
#: Characters of output kept per run in total.
RUN_OUTPUT_BUDGET = 600_000
INTERRUPTED = "The run was interrupted because the server restarted."


class RunNotFoundError(NotFoundError):
    code = "run_not_found"
    message = "Run not found."


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
    )


def _to_info(run_id: str, data: dict[str, Any]) -> RunInfo:
    return RunInfo(
        run_id=run_id,
        flow_id=data["flow_id"],
        flow_version=data["flow_version"],
        status=data["status"],
        trigger_id=data["trigger_id"],
        input=data.get("input"),
        error=data.get("error"),
        created_at=data["created_at"],
        started_at=data.get("started_at"),
        finished_at=data.get("finished_at"),
        node_states={k: _node_state(v) for k, v in (data.get("node_states") or {}).items()},
    )


class RunRepository:
    def __init__(self, db: firestore.AsyncClient) -> None:
        self._collection = db.collection(COLLECTION)

    async def create(
        self,
        *,
        owner_uid: str,
        flow_id: str,
        flow_version: int,
        trigger_id: str,
        input: str | None,
    ) -> RunInfo:
        ref = self._collection.document()
        data = {
            "owner_uid": owner_uid,
            "flow_id": flow_id,
            "flow_version": flow_version,
            "status": "queued",
            "trigger_id": trigger_id,
            "input": input,
            "error": None,
            "created_at": datetime.now(UTC),
            "started_at": None,
            "finished_at": None,
            "node_states": {},
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
        if not live and data["status"] not in FINISHED_RUN_STATUSES:
            fields = {"status": "failed", "error": INTERRUPTED, "finished_at": datetime.now(UTC)}
            await self.update(run_id, fields)
            data |= fields
        return _to_info(run_id, data)


class RunRecorder:
    """Persists a run's events as they happen. `record` never blocks the runner: updates are
    merged in memory and written by one background task, in order; `close` flushes them."""

    def __init__(self, repository: RunRepository, run_id: str) -> None:
        self._repository = repository
        self._run_id = run_id
        self._nodes: dict[str, dict[str, Any]] = {}
        self._pending: dict[str, Any] = {}
        self._output_budget = RUN_OUTPUT_BUDGET
        self._wake = asyncio.Event()
        self._closing = False
        self._worker = asyncio.create_task(self._write_loop(), name=f"run-recorder:{run_id}")

    def record(self, event: RunEvent) -> None:
        kind = event["type"]
        at = datetime.fromisoformat(event["at"])
        if kind == "run_started":
            self._pending |= {"status": "running", "started_at": at}
        elif kind == "node_started":
            self._set_node(event["node_id"], {"status": "running", "started_at": at})
        elif kind == "node_finished":
            state = {**self._nodes.get(event["node_id"], {}), "status": event["status"]}
            state["finished_at"] = at
            if event.get("error"):
                state["error"] = event["error"]
            if event["status"] == "succeeded":
                state["handles"] = event.get("handles", [])
                state |= self._encode_output(event.get("output"))
            self._set_node(event["node_id"], state)
        elif kind == "run_finished":
            self._pending |= {
                "status": event["status"],
                "error": event.get("error"),
                "finished_at": at,
            }
        else:
            return  # tokens and logs are stream-only
        self._wake.set()

    def _set_node(self, node_id: str, state: dict[str, Any]) -> None:
        self._nodes[node_id] = state
        # The whole entry, so a later write of the same node simply replaces it.
        self._pending[FieldPath("node_states", node_id).to_api_repr()] = state

    def _encode_output(self, output: Any) -> dict[str, Any]:
        encoded = json.dumps(output, ensure_ascii=False, default=str)
        limit = min(OUTPUT_MAX_CHARS, self._output_budget)
        if len(encoded) <= limit:
            self._output_budget -= len(encoded)
            return {"output_json": encoded, "output_truncated": False}
        preview = output if isinstance(output, str) else encoded
        preview = preview[: max(limit, 0)]
        self._output_budget -= len(preview)
        return {"output_json": preview, "output_truncated": True}

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
