"""Run events: what the runner reports while a flow executes.

They are streamed to the editor over SSE (`GET /runs/{id}/stream`) and drive persistence: only
status transitions and outputs reach Firestore; tokens and logs are stream-only (context.md D2).

    run_started    {run_id, trigger_id}
    node_started   {node_id, iteration?}                 iteration: inside a loop (1, 2, …)
    token          {node_id, text}                       streamed LLM output
    log            {node_id?, level, message}
    tool_call      {node_id, tool_node_id, call_id, name, arguments}
                   an agent (node_id) calls the node attached as its tool
    tool_result    {node_id, tool_node_id, call_id, status, output?, error?}
                   status: succeeded | failed (the error goes back to the agent)
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


def node_started(node_id: str, iteration: int | None = None) -> RunEvent:
    """`iteration`: for steps inside a loop, which pass of the innermost loop this is (1, 2, …)."""
    return event("node_started", node_id=node_id, iteration=iteration)


def token(node_id: str, text: str) -> RunEvent:
    return event("token", node_id=node_id, text=text)


def log(message: str, level: LogLevel = "info", node_id: str | None = None) -> RunEvent:
    return event("log", node_id=node_id, level=level, message=message)


def tool_call(node_id: str, tool_node_id: str, call_id: str, name: str, arguments: Any) -> RunEvent:
    return event(
        "tool_call",
        node_id=node_id,
        tool_node_id=tool_node_id,
        call_id=call_id,
        name=name,
        arguments=arguments,
    )


def tool_result(
    node_id: str,
    tool_node_id: str,
    call_id: str,
    *,
    output: Any = None,
    error: str | None = None,
) -> RunEvent:
    status = "failed" if error is not None else "succeeded"
    result = event(
        "tool_result",
        node_id=node_id,
        tool_node_id=tool_node_id,
        call_id=call_id,
        status=status,
        error=error,
    )
    if error is None:
        result["output"] = output
    return result


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
