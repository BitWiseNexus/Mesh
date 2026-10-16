"""Knowledge bases: list / create / read / change settings / delete, and their documents."""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response, UploadFile, status

from app.api.credentials import Repo as CredentialRepo
from app.api.models import saved_providers
from app.core.auth import CurrentUser
from app.core.errors import ApiError
from app.core.firebase import get_db
from app.llm.embeddings import default_embedding_model, is_embedding_model
from app.llm.models import server_providers
from app.repositories.knowledge import KnowledgeBaseRepository
from app.schemas.knowledge import (
    MAX_DOCUMENT_BYTES,
    KnowledgeBase,
    KnowledgeBaseCreate,
    KnowledgeBaseUpdate,
    KnowledgeDocument,
)
from app.services import documents

router = APIRouter(prefix="/knowledge-bases", tags=["knowledge"])


def get_knowledge_base_repository() -> KnowledgeBaseRepository:
    return KnowledgeBaseRepository(get_db())


Repo = Annotated[KnowledgeBaseRepository, Depends(get_knowledge_base_repository)]
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
    knowledge_base_id: KnowledgeBaseId, user: CurrentUser, repo: Repo
) -> Response:
    """Deletes it with its documents and their files."""
    await repo.delete(user.uid, knowledge_base_id)
    await documents.delete_folder(documents.folder(user.uid, knowledge_base_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Documents ─────────────────────────────────────────────────────────────


@router.get("/{knowledge_base_id}/documents")
async def list_documents(
    knowledge_base_id: KnowledgeBaseId, user: CurrentUser, repo: Repo
) -> list[KnowledgeDocument]:
    """Newest first, with their processing status."""
    return await repo.list_documents(user.uid, knowledge_base_id)


@router.post("/{knowledge_base_id}/documents", status_code=status.HTTP_201_CREATED)
async def upload_document(
    knowledge_base_id: KnowledgeBaseId, file: UploadFile, user: CurrentUser, repo: Repo
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
        return await repo.add_document(
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


@router.delete(
    "/{knowledge_base_id}/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_document(
    knowledge_base_id: KnowledgeBaseId, document_id: DocumentId, user: CurrentUser, repo: Repo
) -> Response:
    """404 `document_not_found`."""
    path = await repo.delete_document(user.uid, knowledge_base_id, document_id)
    await documents.delete_file(path)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
