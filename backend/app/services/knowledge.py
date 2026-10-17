"""A run owner's knowledge bases, as executors see them (`ctx.run.knowledge`)."""

from typing import Any

from app.core.errors import ApiError
from app.engine.context import Secrets
from app.engine.executor import NodeError
from app.llm import LlmError
from app.llm.embeddings import embed, embedding_model
from app.repositories.chunks import ChunkRepository
from app.repositories.knowledge import KnowledgeBaseNotFoundError, KnowledgeBaseRepository
from app.schemas.knowledge import DocumentStatus
from app.services import documents
from app.services.ingestion import IngestionManager, Job

GONE = "The knowledge base no longer exists (or isn't yours): choose another one"


class UserKnowledge:
    """The owner's knowledge bases. Searches embed the query with the knowledge base's own model
    (as a query) using the owner's key for it, else the server's; added documents go through the
    same checks and processing as uploads."""

    def __init__(
        self,
        repository: KnowledgeBaseRepository,
        chunks: ChunkRepository,
        owner_uid: str,
        secrets: Secrets,
        ingestion: IngestionManager | None = None,
    ) -> None:
        self._repository = repository
        self._chunks = chunks
        self._owner_uid = owner_uid
        self._secrets = secrets
        self._ingestion = ingestion

    async def search(self, knowledge_base_id: str, query: str, top_k: int) -> list[dict[str, Any]]:
        try:
            kb = await self._repository.get(self._owner_uid, knowledge_base_id)
        except KnowledgeBaseNotFoundError:
            raise NodeError(GONE) from None
        model = embedding_model(kb.embedding_model)
        api_key = None
        if model is not None and model.provider is not None:
            api_key = await self._secrets.get(model.provider)
        try:
            [vector] = await embed(kb.embedding_model, [query], api_key=api_key, task="query")
        except LlmError as exc:
            raise NodeError(f"Couldn't search “{kb.name}”: {exc}") from exc
        return await self._chunks.search(knowledge_base_id, vector, top_k)

    async def add_document(self, knowledge_base_id: str, name: str, text: str) -> dict[str, Any]:
        if self._ingestion is None:
            raise NodeError("Documents can't be added in this run")
        try:
            document = await documents.store(
                self._repository, self._owner_uid, knowledge_base_id, name, text.encode()
            )
        except KnowledgeBaseNotFoundError:
            raise NodeError(GONE) from None
        except ApiError as exc:  # too large, the document limit, …
            raise NodeError(exc.message) from exc
        job = Job(self._owner_uid, knowledge_base_id, document.document_id)
        await self._ingestion.process(job)
        done = await self._repository.get_document(
            self._owner_uid, knowledge_base_id, document.document_id
        )
        if done.status != DocumentStatus.READY:
            raise NodeError(f"“{done.name}” was stored but couldn't be processed: {done.error}")
        return {
            "document_id": done.document_id,
            "name": done.name,
            "knowledge_base_id": knowledge_base_id,
            "chunk_count": done.chunk_count,
        }
