"""Run events: what the runner reports while a flow executes.

They are streamed to the editor over SSE (`GET /runs/{id}/stream`) and drive persistence: only
status transitions and outputs reach Firestore; tokens and logs are stream-only (context.md D2).

    run_started    {run_id, trigger_id}
    node_started   {node_id}
    token          {node_id, text}                       streamed LLM output
    log            {node_id?, level, message}
    node_finished  {node_id, status, output?, handles?, error?}
                   status: succeeded | failed | skipped | cancelled
                   handles: the output handles that delivered (others were skipped)
    run_finished   {status, error?}                      status: succeeded | failed | cancelled

Every event also has `type` and `at` (ISO-8601 UTC); the event log adds `seq` (1, 2, …).
"""

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Literal

RunEvent = dict[str, Any]
#: Receives events synchronously, in order. Must not block (no I/O): buffer and write elsewhere.
EventSink = Callable[[RunEvent], None]

NodeStatus = Literal["pending", "running", "succeeded", "failed", "skipped", "cancelled"]
RunStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
LogLevel = Literal["info", "warning", "error"]

FINISHED_RUN_STATUSES: frozenset[str] = frozenset({"succeeded", "failed", "cancelled"})


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def event(type: str, **fields: Any) -> RunEvent:
    return {"type": type, **{k: v for k, v in fields.items() if v is not None}, "at": now_iso()}


def run_started(run_id: str, trigger_id: str) -> RunEvent:
    return event("run_started", run_id=run_id, trigger_id=trigger_id)


def node_started(node_id: str) -> RunEvent:
    return event("node_started", node_id=node_id)


def token(node_id: str, text: str) -> RunEvent:
    return event("token", node_id=node_id, text=text)


def log(message: str, level: LogLevel = "info", node_id: str | None = None) -> RunEvent:
    return event("log", node_id=node_id, level=level, message=message)


def node_finished(
    node_id: str,
    status: NodeStatus,
    *,
    output: Any = None,
    handles: list[str] | None = None,
    error: str | None = None,
) -> RunEvent:
    finished = event("node_finished", node_id=node_id, status=status, error=error)
    if status == "succeeded":
        # `output` is kept even when None ("succeeded without output").
        finished |= {"output": output, "handles": handles or []}
    return finished


def run_finished(status: RunStatus, error: str | None = None) -> RunEvent:
    return event("run_finished", status=status, error=error)
