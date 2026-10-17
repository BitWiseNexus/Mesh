"""Knowledge bases: list / create / read / change settings / delete, and their documents."""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Request, Response, UploadFile, status

from app.api.credentials import Repo as CredentialRepo
from app.api.models import saved_providers
from app.core.auth import CurrentUser
from app.core.errors import ApiError
from app.core.firebase import get_db
from app.llm.embeddings import default_embedding_model, is_embedding_model
from app.llm.models import server_providers
from app.repositories.chunks import ChunkRepository
from app.repositories.knowledge import KnowledgeBaseRepository
from app.schemas.knowledge import (
    MAX_DOCUMENT_BYTES,
    DocumentStatus,
    KnowledgeBase,
    KnowledgeBaseCreate,
    KnowledgeBaseUpdate,
    KnowledgeDocument,
)
from app.services import documents
from app.services.ingestion import IngestionManager, Job

router = APIRouter(prefix="/knowledge-bases", tags=["knowledge"])


def get_knowledge_base_repository() -> KnowledgeBaseRepository:
    return KnowledgeBaseRepository(get_db())


def get_chunk_repository() -> ChunkRepository:
    return ChunkRepository(get_db())


def get_ingestion(request: Request) -> IngestionManager:
    return request.app.state.ingestion


Repo = Annotated[KnowledgeBaseRepository, Depends(get_knowledge_base_repository)]
Chunks = Annotated[ChunkRepository, Depends(get_chunk_repository)]
Ingestion = Annotated[IngestionManager, Depends(get_ingestion)]
KnowledgeBaseId = Annotated[str, Path(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")]
DocumentId = Annotated[str, Path(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")]


class UnknownEmbeddingModelError(ApiError):
    status_code = 422
    code = "unknown_embedding_model"
    message = "That embedding model isn't available."


def _checked(model: str | None) -> str | None:
    if model is not None and not is_embedding_model(model):
        raise UnknownEmbeddingModelError()
    return model


@router.get("")
async def list_knowledge_bases(user: CurrentUser, repo: Repo) -> list[KnowledgeBase]:
    """The caller's knowledge bases, most recently changed first."""
    return await repo.list(user.uid)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_knowledge_base(
    body: KnowledgeBaseCreate, user: CurrentUser, repo: Repo, credentials: CredentialRepo
) -> KnowledgeBase:
    """Without `embedding_model`: the caller's default (a provider they have a key for). 409
    `too_many_knowledge_bases` beyond 100; 422 `unknown_embedding_model`."""
    model = _checked(body.embedding_model) or default_embedding_model(
        await saved_providers(credentials, user.uid), server_providers()
    )
    return await repo.create(user.uid, body, model)


@router.get("/{knowledge_base_id}")
async def get_knowledge_base(
    knowledge_base_id: KnowledgeBaseId, user: CurrentUser, repo: Repo
) -> KnowledgeBase:
    return await repo.get(user.uid, knowledge_base_id)


@router.patch("/{knowledge_base_id}")
async def update_knowledge_base(
    knowledge_base_id: KnowledgeBaseId, body: KnowledgeBaseUpdate, user: CurrentUser, repo: Repo
) -> KnowledgeBase:
    """409 `embedding_model_locked` when changing the model of one that has documents; 422
    `invalid_knowledge_base_settings` (overlap over half the chunk size) or
    `unknown_embedding_model`."""
    _checked(body.embedding_model)
    return await repo.update(user.uid, knowledge_base_id, body)


@router.delete("/{knowledge_base_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_knowledge_base(
    knowledge_base_id: KnowledgeBaseId,
    user: CurrentUser,
    repo: Repo,
    chunks: Chunks,
    ingestion: Ingestion,
) -> Response:
    """Deletes it with its documents, their chunks and files."""
    await repo.get(user.uid, knowledge_base_id)  # 404 before touching anything
    await ingestion.cancel_knowledge_base(knowledge_base_id)
    await repo.delete(user.uid, knowledge_base_id)
    await chunks.delete_for_knowledge_base(knowledge_base_id)
    await documents.delete_folder(documents.folder(user.uid, knowledge_base_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Documents ─────────────────────────────────────────────────────────────


@router.get("/{knowledge_base_id}/documents")
async def list_documents(
    knowledge_base_id: KnowledgeBaseId, user: CurrentUser, repo: Repo, ingestion: Ingestion
) -> list[KnowledgeDocument]:
    """Newest first, with their processing status. Documents left waiting or half-processed with
    nothing working on them (e.g. the server restarted) are queued again."""
    found = await repo.list_documents(user.uid, knowledge_base_id)
    for document in found:
        unfinished = document.status in (DocumentStatus.PENDING, DocumentStatus.PROCESSING)
        if unfinished and not ingestion.is_active(document.document_id):
            ingestion.submit(Job(user.uid, knowledge_base_id, document.document_id))
    return found


@router.post("/{knowledge_base_id}/documents", status_code=status.HTTP_201_CREATED)
async def upload_document(
    knowledge_base_id: KnowledgeBaseId,
    file: UploadFile,
    user: CurrentUser,
    repo: Repo,
    ingestion: Ingestion,
) -> KnowledgeDocument:
    """One file (multipart field `file`): PDF, plain text or Markdown, at most 10 MB. It's stored
    and recorded as `pending`, then processed into searchable chunks. 415
    `unsupported_document_type`, 413 `document_too_large`, 422 `empty_document`, 409
    `too_many_documents`."""
    await repo.get(user.uid, knowledge_base_id)  # 404 before storing anything
    checked = documents.check_file(file.filename, await file.read(MAX_DOCUMENT_BYTES + 1))
    document_id = repo.new_document_id(knowledge_base_id)
    path = documents.file_path(user.uid, knowledge_base_id, document_id)
    await documents.save_file(path, checked)
    try:
        document = await repo.add_document(
            user.uid,
            knowledge_base_id,
            document_id,
            name=checked.name,
            mime=checked.mime,
            size=len(checked.data),
            storage_path=path,
        )
    except Exception:
        await documents.delete_file(path)  # not recorded (e.g. the limit): don't keep the file
        raise
    ingestion.submit(Job(user.uid, knowledge_base_id, document_id))
    return document


@router.delete(
    "/{knowledge_base_id}/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_document(
    knowledge_base_id: KnowledgeBaseId,
    document_id: DocumentId,
    user: CurrentUser,
    repo: Repo,
    chunks: Chunks,
    ingestion: Ingestion,
) -> Response:
    """Deletes it with its chunks and file. 404 `document_not_found`."""
    await repo.get(user.uid, knowledge_base_id)  # 404 before touching anything
    await ingestion.cancel(document_id)
    path = await repo.delete_document(user.uid, knowledge_base_id, document_id)
    await chunks.delete_for_document(knowledge_base_id, document_id)
    await documents.delete_file(path)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{knowledge_base_id}/documents/{document_id}/retry")
async def retry_document(
    knowledge_base_id: KnowledgeBaseId,
    document_id: DocumentId,
    user: CurrentUser,
    repo: Repo,
    ingestion: Ingestion,
) -> KnowledgeDocument:
    """Processes the document again (e.g. after adding the API key it was missing). Returns it as
    `pending`; already being processed → unchanged. 404 `document_not_found`."""
    document = await repo.get_document(user.uid, knowledge_base_id, document_id)
    if ingestion.is_active(document_id):
        return document
    await repo.set_document_status(knowledge_base_id, document_id, DocumentStatus.PENDING)
    ingestion.submit(Job(user.uid, knowledge_base_id, document_id))
    return await repo.get_document(user.uid, knowledge_base_id, document_id)
