"""Request/response models for the /flows API."""

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.flow import Flow


class StoredFlow(Flow):
    """A flow as persisted: always has an id, timestamps and a version for concurrency control."""

    flow_id: str
    created_at: datetime
    updated_at: datetime
    version: int = Field(ge=1)


class FlowSummary(BaseModel):
    """List-view projection (no graph)."""

    flow_id: str
    name: str
    description: str
    node_count: int
    created_at: datetime
    updated_at: datetime
    version: int


class FlowUpdate(Flow):
    """Full replacement of a flow's content. `expected_version` enables optimistic concurrency:
    the write is rejected with 409 if the stored version differs (e.g. saved from another tab)."""

    expected_version: int | None = Field(default=None, ge=1)


class FlowMetaUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    expected_version: int | None = Field(default=None, ge=1)
