"""Firestore persistence for knowledge bases. Every method is scoped to the owner's uid.

Document `knowledge_bases/{knowledge_base_id}`:
    owner_uid, name, description, embedding_model, chunk_size, chunk_overlap, document_count,
    created_at, updated_at
Subcollection `documents` (7.2) and chunks in `kb_chunks` (7.3) belong to it and go with it.

Security rules deny every client read and write: the API is the only way in.
"""

# Annotations stay unevaluated: the class's `list` method would shadow the builtin in them.
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from google.cloud import firestore
from google.cloud.firestore_v1 import FieldFilter

from app.core.errors import ApiError, ConflictError, NotFoundError
from app.schemas.knowledge import (
    MAX_DOCUMENTS,
    DocumentStatus,
    KnowledgeBase,
    KnowledgeBaseCreate,
    KnowledgeBaseUpdate,
    KnowledgeDocument,
    check_overlap,
)

COLLECTION = "knowledge_bases"
MAX_PER_USER = 100
_DELETE_BATCH = 400


class KnowledgeBaseNotFoundError(NotFoundError):
    code = "knowledge_base_not_found"
    message = "Knowledge base not found."


class TooManyKnowledgeBasesError(ApiError):
    status_code = 409
    code = "too_many_knowledge_bases"
    message = f"You can have up to {MAX_PER_USER} knowledge bases. Delete one first."


class EmbeddingModelLockedError(ConflictError):
    code = "embedding_model_locked"
    message = (
        "The embedding model can't change once a knowledge base has documents: they were "
        "embedded with the current one. Create a new knowledge base instead."
    )


class DocumentNotFoundError(NotFoundError):
    code = "document_not_found"
    message = "Document not found."


class TooManyDocumentsError(ConflictError):
    code = "too_many_documents"
    message = f"A knowledge base can hold up to {MAX_DOCUMENTS} documents. Delete some first."


class InvalidKnowledgeBaseSettingsError(ApiError):
    status_code = 422
    code = "invalid_knowledge_base_settings"


def _to_model(snapshot: Any) -> KnowledgeBase:
    data = snapshot.to_dict()
    return KnowledgeBase(
        knowledge_base_id=snapshot.id,
        name=data["name"],
        description=data.get("description", ""),
        embedding_model=data["embedding_model"],
        chunk_size=data["chunk_size"],
        chunk_overlap=data["chunk_overlap"],
        document_count=data.get("document_count", 0),
        created_at=data["created_at"],
        updated_at=data["updated_at"],
    )


def _to_document(snapshot: Any) -> KnowledgeDocument:
    data = snapshot.to_dict()
    return KnowledgeDocument(
        document_id=snapshot.id,
        name=data["name"],
        mime=data["mime"],
        size=data["size"],
        status=data["status"],
        error=data.get("error"),
        chunk_count=data.get("chunk_count", 0),
        created_at=data["created_at"],
        updated_at=data["updated_at"],
    )


class KnowledgeBaseRepository:
    def __init__(self, db: firestore.AsyncClient) -> None:
        self._db = db
        self._collection = db.collection(COLLECTION)

    def _owned_query(self, owner_uid: str) -> Any:
        return self._collection.where(filter=FieldFilter("owner_uid", "==", owner_uid))

    @staticmethod
    def _check_owner(snapshot: Any, owner_uid: str) -> None:
        # Someone else's knowledge base is reported exactly like a missing one.
        if not snapshot.exists or snapshot.get("owner_uid") != owner_uid:
            raise KnowledgeBaseNotFoundError()

    async def list(self, owner_uid: str) -> list[KnowledgeBase]:
        """Most recently changed first (sorted here: at most MAX_PER_USER, no composite index)."""
        found = [_to_model(s) async for s in self._owned_query(owner_uid).stream()]
        return sorted(found, key=lambda kb: kb.updated_at, reverse=True)

    async def get(self, owner_uid: str, knowledge_base_id: str) -> KnowledgeBase:
        snapshot = await self._collection.document(knowledge_base_id).get()
        self._check_owner(snapshot, owner_uid)
        return _to_model(snapshot)

    async def create(
        self, owner_uid: str, body: KnowledgeBaseCreate, embedding_model: str
    ) -> KnowledgeBase:
        """`embedding_model`: already validated (or chosen) by the caller."""
        existing = await self._owned_query(owner_uid).count().get()
        if existing[0][0].value >= MAX_PER_USER:
            raise TooManyKnowledgeBasesError()
        now = datetime.now(UTC)
        ref = self._collection.document()
        await ref.create(
            {
                "owner_uid": owner_uid,
                "name": body.name.strip(),
                "description": body.description.strip(),
                "embedding_model": embedding_model,
                "chunk_size": body.chunk_size,
                "chunk_overlap": body.chunk_overlap,
                "document_count": 0,
                "created_at": now,
                "updated_at": now,
            }
        )
        return _to_model(await ref.get())

    async def update(
        self, owner_uid: str, knowledge_base_id: str, body: KnowledgeBaseUpdate
    ) -> KnowledgeBase:
        """`body.embedding_model`, if set, must already be validated by the caller."""
        ref = self._collection.document(knowledge_base_id)

        @firestore.async_transactional
        async def apply(transaction: Any) -> None:
            snapshot = await ref.get(transaction=transaction)
            self._check_owner(snapshot, owner_uid)
            current = snapshot.to_dict()
            fields: dict[str, Any] = {"updated_at": datetime.now(UTC)}
            if body.name is not None:
                fields["name"] = body.name.strip()
            if body.description is not None:
                fields["description"] = body.description.strip()
            if body.chunk_size is not None:
                fields["chunk_size"] = body.chunk_size
            if body.chunk_overlap is not None:
                fields["chunk_overlap"] = body.chunk_overlap
            try:
                check_overlap(
                    fields.get("chunk_size", current["chunk_size"]),
                    fields.get("chunk_overlap", current["chunk_overlap"]),
                )
            except ValueError as exc:
                raise InvalidKnowledgeBaseSettingsError(str(exc).capitalize() + ".") from exc
            model = body.embedding_model
            if model is not None and model != current["embedding_model"]:
                if current.get("document_count", 0) > 0:
                    raise EmbeddingModelLockedError()
                fields["embedding_model"] = model
            transaction.update(ref, fields)

        await apply(self._db.transaction())
        return _to_model(await ref.get())

    async def delete(self, owner_uid: str, knowledge_base_id: str) -> None:
        """Deletes the knowledge base and its documents."""
        ref = self._collection.document(knowledge_base_id)
        self._check_owner(await ref.get(), owner_uid)
        documents = ref.collection("documents")
        while True:
            batch_docs = [d async for d in documents.limit(_DELETE_BATCH).stream()]
            if not batch_docs:
                break
            batch = self._db.batch()
            for doc in batch_docs:
                batch.delete(doc.reference)
            await batch.commit()
        await ref.delete()

    # ── Documents (`knowledge_bases/{id}/documents/{document_id}`) ─────────────

    def _documents(self, knowledge_base_id: str) -> Any:
        return self._collection.document(knowledge_base_id).collection("documents")

    def new_document_id(self, knowledge_base_id: str) -> str:
        return self._documents(knowledge_base_id).document().id

    async def list_documents(
        self, owner_uid: str, knowledge_base_id: str
    ) -> list[KnowledgeDocument]:
        """Newest first."""
        self._check_owner(await self._collection.document(knowledge_base_id).get(), owner_uid)
        found = [_to_document(s) async for s in self._documents(knowledge_base_id).stream()]
        return sorted(found, key=lambda d: d.created_at, reverse=True)

    async def add_document(
        self,
        owner_uid: str,
        knowledge_base_id: str,
        document_id: str,
        *,
        name: str,
        mime: str,
        size: int,
        storage_path: str,
    ) -> KnowledgeDocument:
        """Records an uploaded file as a `pending` document and counts it — one transaction, so the
        limit and the embedding-model lock (which looks at the count) can't race."""
        kb_ref = self._collection.document(knowledge_base_id)
        doc_ref = self._documents(knowledge_base_id).document(document_id)

        @firestore.async_transactional
        async def apply(transaction: Any) -> None:
            snapshot = await kb_ref.get(transaction=transaction)
            self._check_owner(snapshot, owner_uid)
            if snapshot.get("document_count") >= MAX_DOCUMENTS:
                raise TooManyDocumentsError()
            now = datetime.now(UTC)
            transaction.create(
                doc_ref,
                {
                    "owner_uid": owner_uid,
                    "name": name,
                    "source": "upload",
                    "mime": mime,
                    "size": size,
                    "storage_path": storage_path,
                    "status": DocumentStatus.PENDING.value,
                    "error": None,
                    "chunk_count": 0,
                    "created_at": now,
                    "updated_at": now,
                },
            )
            transaction.update(
                kb_ref, {"document_count": firestore.Increment(1), "updated_at": now}
            )

        await apply(self._db.transaction())
        return _to_document(await doc_ref.get())

    async def delete_document(
        self, owner_uid: str, knowledge_base_id: str, document_id: str
    ) -> str:
        """Deletes the record and uncounts it; returns its file's storage path (for the caller to
        delete)."""
        kb_ref = self._collection.document(knowledge_base_id)
        doc_ref = self._documents(knowledge_base_id).document(document_id)

        @firestore.async_transactional
        async def apply(transaction: Any) -> str:
            self._check_owner(await kb_ref.get(transaction=transaction), owner_uid)
            document = await doc_ref.get(transaction=transaction)
            if not document.exists:
                raise DocumentNotFoundError()
            transaction.delete(doc_ref)
            transaction.update(
                kb_ref,
                {"document_count": firestore.Increment(-1), "updated_at": datetime.now(UTC)},
            )
            return document.get("storage_path")

        return await apply(self._db.transaction())
