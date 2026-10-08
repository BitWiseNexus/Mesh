"""Request/response models for runs (`/flows/{id}/runs`, `/runs/{id}`)."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.engine.events import NodeStatus, RunStatus


class RunRequest(BaseModel):
    #: The trigger that starts the run; optional when the flow has exactly one.
    trigger_id: str | None = None
    #: Text the trigger outputs; None → the Manual Trigger's default input.
    input: str | None = Field(default=None, max_length=100_000)


class NodeRunState(BaseModel):
    status: NodeStatus
    started_at: datetime | None = None
    finished_at: datetime | None = None
    #: The node's output (when it succeeded). When `output_truncated`, a text preview instead.
    output: Any = None
    output_truncated: bool = False
    error: str | None = None
    #: Output handles that delivered.
    handles: list[str] | None = None
    #: Tools: how often the agent called it (the other fields describe the latest call).
    calls: int | None = None


class RunInfo(BaseModel):
    run_id: str
    flow_id: str
    flow_version: int
    status: RunStatus
    trigger_id: str
    input: str | None = None
    error: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    node_states: dict[str, NodeRunState] = Field(default_factory=dict)
