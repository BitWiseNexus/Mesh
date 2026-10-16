"""Knowledge bases (`/knowledge-bases`): a user's collections of documents that flows search."""

from datetime import datetime
from typing import Self

from pydantic import BaseModel, Field, model_validator

MAX_NAME_LENGTH = 100
MAX_DESCRIPTION_LENGTH = 500
#: Chunks are measured in characters.
DEFAULT_CHUNK_SIZE = 1000
DEFAULT_CHUNK_OVERLAP = 150
MIN_CHUNK_SIZE = 200
MAX_CHUNK_SIZE = 4000


def check_overlap(size: int | None, overlap: int | None) -> None:
    if size is not None and overlap is not None and overlap > size // 2:
        raise ValueError("chunk_overlap can be at most half of chunk_size")


class KnowledgeBaseCreate(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)
    description: str = Field(default="", max_length=MAX_DESCRIPTION_LENGTH)
    #: None: the default for this user (see app/llm/embeddings.py).
    embedding_model: str | None = None
    chunk_size: int = Field(default=DEFAULT_CHUNK_SIZE, ge=MIN_CHUNK_SIZE, le=MAX_CHUNK_SIZE)
    chunk_overlap: int = Field(default=DEFAULT_CHUNK_OVERLAP, ge=0, le=MAX_CHUNK_SIZE // 2)

    @model_validator(mode="after")
    def _overlap(self) -> Self:
        check_overlap(self.chunk_size, self.chunk_overlap)
        return self


class KnowledgeBaseUpdate(BaseModel):
    """Only the fields sent change. Chunk settings apply to documents added afterwards; the
    embedding model can change only while the knowledge base has no documents."""

    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME_LENGTH)
    description: str | None = Field(default=None, max_length=MAX_DESCRIPTION_LENGTH)
    embedding_model: str | None = None
    chunk_size: int | None = Field(default=None, ge=MIN_CHUNK_SIZE, le=MAX_CHUNK_SIZE)
    chunk_overlap: int | None = Field(default=None, ge=0, le=MAX_CHUNK_SIZE // 2)

    @model_validator(mode="after")
    def _overlap(self) -> Self:
        check_overlap(self.chunk_size, self.chunk_overlap)
        return self


class KnowledgeBase(BaseModel):
    knowledge_base_id: str
    name: str
    description: str
    embedding_model: str
    chunk_size: int
    chunk_overlap: int
    document_count: int
    created_at: datetime
    updated_at: datetime
