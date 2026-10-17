"""Processing uploaded documents into searchable chunks, in the background.

pending → processing → ready (chunk_count) | failed (error): read the file from storage, extract
its text, split it with the knowledge base's chunk settings, embed the chunks with its embedding
model (the owner's saved key for that provider, else the server's), and store them in `kb_chunks`
(replacing any from an earlier attempt).

`IngestionManager` (on `app.state.ingestion`) runs this as tasks in this process, a few at a time.
Uploads submit their document; listing a knowledge base's documents resubmits any left
pending/processing without a task here (e.g. after a restart) — so, like runs, ingestion needs a
single backend instance until it moves to a worker queue. Deleting a document or knowledge base
cancels its processing first.
"""

import asyncio
import contextlib
import logging
from dataclasses import dataclass

from app.core.firebase import get_db
from app.llm import LlmError
from app.llm.embeddings import embed, embedding_model
from app.repositories.chunks import ChunkRepository
from app.repositories.credentials import CredentialRepository
from app.repositories.knowledge import KnowledgeBaseRepository
from app.schemas.knowledge import DocumentStatus
from app.services import documents
from app.services.chunking import ExtractionError, chunk_pages, extract_pages
from app.services.credentials import UserSecrets

logger = logging.getLogger(__name__)

#: More chunks than this and the document is refused (embedding cost, write volume).
MAX_CHUNKS_PER_DOCUMENT = 5000
CONCURRENCY = 2


class IngestionError(Exception):
    """Processing failed; the message is meant for the user."""


@dataclass(frozen=True)
class Job:
    owner_uid: str
    knowledge_base_id: str
    document_id: str


async def ingest(job: Job) -> None:
    """Processes one document, recording the outcome on it. Never raises (except cancellation)."""
    db = get_db()
    knowledge = KnowledgeBaseRepository(db)
    chunks_repo = ChunkRepository(db)
    kb_id, doc_id = job.knowledge_base_id, job.document_id

    record = await knowledge.document_record(kb_id, doc_id)
    kb = await knowledge.knowledge_base_record(kb_id)
    if record is None or kb is None:
        return  # deleted meanwhile
    if not await knowledge.set_document_status(kb_id, doc_id, DocumentStatus.PROCESSING):
        return
    try:
        count = await _process(job, record, kb, chunks_repo)
    except asyncio.CancelledError:
        raise
    except (IngestionError, ExtractionError, LlmError) as exc:
        await knowledge.set_document_status(kb_id, doc_id, DocumentStatus.FAILED, error=str(exc))
        return
    except Exception:
        logger.exception("Processing document %s of knowledge base %s failed", doc_id, kb_id)
        await knowledge.set_document_status(
            kb_id, doc_id, DocumentStatus.FAILED, error="Unexpected error while processing it."
        )
        return
    finished = await knowledge.set_document_status(
        kb_id, doc_id, DocumentStatus.READY, chunk_count=count
    )
    if not finished:  # deleted while we were working: don't leave its chunks behind
        await chunks_repo.delete_for_document(kb_id, doc_id)


async def _process(job: Job, record: dict, kb: dict, chunks_repo: ChunkRepository) -> int:
    data = await documents.read_file(record["storage_path"])
    pages = await asyncio.to_thread(extract_pages, data, record["mime"])
    chunks = chunk_pages(pages, kb["chunk_size"], kb["chunk_overlap"])
    if not chunks:
        raise IngestionError("No text found in this document.")
    if len(chunks) > MAX_CHUNKS_PER_DOCUMENT:
        raise IngestionError(
            f"This document is too long: it makes {len(chunks)} chunks (at most "
            f"{MAX_CHUNKS_PER_DOCUMENT}). Split it into smaller files, or use larger chunks."
        )
    model = embedding_model(kb["embedding_model"])
    api_key = None
    if model is not None and model.provider is not None:
        secrets = UserSecrets(CredentialRepository(get_db()), job.owner_uid)
        api_key = await secrets.get(model.provider)
    vectors = await embed(kb["embedding_model"], [c.text for c in chunks], api_key=api_key)
    await chunks_repo.replace_for_document(
        job.owner_uid, job.knowledge_base_id, job.document_id, chunks, vectors
    )
    return len(chunks)


class IngestionManager:
    def __init__(self, concurrency: int = CONCURRENCY) -> None:
        self._tasks: dict[str, tuple[Job, asyncio.Task[None]]] = {}
        self._slots = asyncio.Semaphore(concurrency)

    def is_active(self, document_id: str) -> bool:
        return document_id in self._tasks

    def submit(self, job: Job) -> None:
        """Processes the document in the background (no-op if it's already queued here)."""
        if job.document_id in self._tasks:
            return
        task = asyncio.create_task(self._run(job), name=f"ingest:{job.document_id}")
        self._tasks[job.document_id] = (job, task)
        task.add_done_callback(lambda _: self._tasks.pop(job.document_id, None))

    async def _run(self, job: Job) -> None:
        async with self._slots:
            await ingest(job)

    async def cancel(self, document_id: str) -> None:
        entry = self._tasks.get(document_id)
        if entry:
            await self._stop(entry[1])

    async def cancel_knowledge_base(self, knowledge_base_id: str) -> None:
        tasks = [t for job, t in self._tasks.values() if job.knowledge_base_id == knowledge_base_id]
        for task in tasks:
            await self._stop(task)

    async def wait(self) -> None:
        """Until nothing is being processed (tests)."""
        while self._tasks:
            running = [task for _, task in self._tasks.values()]
            await asyncio.gather(*running, return_exceptions=True)

    async def shutdown(self) -> None:
        for _, task in list(self._tasks.values()):
            await self._stop(task)

    @staticmethod
    async def _stop(task: asyncio.Task[None]) -> None:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
