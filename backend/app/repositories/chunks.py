"""Firestore persistence for knowledge-base chunks: the searchable pieces of documents.

Document `kb_chunks/{chunk_id}`:
    owner_uid, kb_id, doc_id, index, text, page (PDFs, else null), embedding (Vector, 768 dims),
    created_at

A top-level collection (not under the knowledge base) so one vector index serves every knowledge
base: searches pre-filter on `kb_id` (firebase/firestore.indexes.json); `text` is exempt from
indexing (chunks can exceed Firestore's index-entry size). Clients can't read it (rules).
"""

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from google.cloud import firestore
from google.cloud.firestore_v1 import FieldFilter
from google.cloud.firestore_v1.vector import Vector

from app.services.chunking import Chunk

COLLECTION = "kb_chunks"
#: Writes per batch (a chunk with its vector is ~10 KB; batches stay well under 10 MB).
_BATCH = 200


class ChunkRepository:
    def __init__(self, db: firestore.AsyncClient) -> None:
        self._db = db
        self._collection = db.collection(COLLECTION)

    async def _delete_matching(self, query: Any) -> int:
        deleted = 0
        while True:
            found = [d async for d in query.limit(_BATCH).stream()]
            if not found:
                return deleted
            batch = self._db.batch()
            for snapshot in found:
                batch.delete(snapshot.reference)
            await batch.commit()
            deleted += len(found)

    async def delete_for_document(self, knowledge_base_id: str, document_id: str) -> int:
        query = self._collection.where(filter=FieldFilter("kb_id", "==", knowledge_base_id)).where(
            filter=FieldFilter("doc_id", "==", document_id)
        )
        return await self._delete_matching(query)

    async def delete_for_knowledge_base(self, knowledge_base_id: str) -> int:
        query = self._collection.where(filter=FieldFilter("kb_id", "==", knowledge_base_id))
        return await self._delete_matching(query)

    async def replace_for_document(
        self,
        owner_uid: str,
        knowledge_base_id: str,
        document_id: str,
        chunks: Sequence[Chunk],
        vectors: Sequence[list[float]],
    ) -> None:
        """The document's chunks, replacing any from an earlier processing of it."""
        await self.delete_for_document(knowledge_base_id, document_id)
        now = datetime.now(UTC)
        for start in range(0, len(chunks), _BATCH):
            batch = self._db.batch()
            for chunk, vector in zip(
                chunks[start : start + _BATCH], vectors[start : start + _BATCH], strict=True
            ):
                batch.set(
                    self._collection.document(),
                    {
                        "owner_uid": owner_uid,
                        "kb_id": knowledge_base_id,
                        "doc_id": document_id,
                        "index": chunk.index,
                        "text": chunk.text,
                        "page": chunk.page,
                        "embedding": Vector(vector),
                        "created_at": now,
                    },
                )
            await batch.commit()
