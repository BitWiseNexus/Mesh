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
    #: Steps inside a loop: the pass this entry is from (the latest one).
    iteration: int | None = None


class PendingApproval(BaseModel):
    """An Approval Gate waiting for a reviewer."""

    node_id: str
    message: str
    #: What the gate received (a text preview when `content_truncated`).
    content: Any = None
    content_truncated: bool = False
    #: The reviewer may change the content before approving.
    allow_edit: bool
    requested_at: datetime


class PendingApprovalItem(BaseModel):
    """One approval waiting for the user, across all their flows (`GET /approvals`)."""

    run_id: str
    flow_id: str
    flow_name: str
    node_id: str
    message: str
    requested_at: datetime


class ApprovalDecision(BaseModel):
    approved: bool
    #: Continue with this instead of the content shown (only if the gate allows editing). Leave
    #: it out to keep the content as it was.
    content: Any = None


class RunSummary(BaseModel):
    """A run in a flow's history (no node states)."""

    run_id: str
    flow_name: str = ""
    flow_version: int
    status: RunStatus
    trigger_id: str
    error: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None


class RunInfo(BaseModel):
    run_id: str
    flow_id: str
    flow_name: str = ""
    flow_version: int
    status: RunStatus
    trigger_id: str
    input: str | None = None
    error: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    node_states: dict[str, NodeRunState] = Field(default_factory=dict)
    #: Status `paused`: the Approval Gates waiting for a reviewer.
    pending_approvals: list[PendingApproval] = Field(default_factory=list)
