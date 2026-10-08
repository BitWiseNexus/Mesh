"""Firestore persistence for flows. Every method is scoped to the owner's uid.

Document `flows/{flow_id}`:
    owner_uid, name, description, schema_version, node_count, version,
    created_at, updated_at,
    graph: JSON string of {"nodes": [...], "edges": [...]}

The graph is stored as one JSON string rather than nested Firestore maps because (a) Firestore
rejects arrays nested in arrays, which arbitrary node config can contain, and (b) Firestore indexes
every nested field by default: wasted writes and a risk of hitting per-document index limits.
`graph` is exempted from indexing in firebase/firestore.indexes.json.
"""

import json
from datetime import UTC, datetime
from typing import Any

from google.cloud import firestore
from google.cloud.firestore_v1 import FieldFilter

from app.core.errors import ConflictError, NotFoundError, PayloadTooLargeError
from app.schemas.flow import Flow
from app.schemas.flows_api import FlowSummary, StoredFlow

COLLECTION = "flows"
# Firestore's document limit is 1 MiB; leave headroom for the other fields.
MAX_GRAPH_BYTES = 900_000
LIST_LIMIT = 200
SUMMARY_FIELDS = ["name", "description", "node_count", "created_at", "updated_at", "version"]


class FlowNotFoundError(NotFoundError):
    code = "flow_not_found"
    message = "Flow not found."


class VersionConflictError(ConflictError):
    code = "version_conflict"
    message = "This flow was changed elsewhere. Reload it to get the latest version."


class FlowTooLargeError(PayloadTooLargeError):
    code = "flow_too_large"
    message = "This flow is too large to save."


def _graph_json(flow: Flow) -> str:
    graph = flow.model_dump(mode="json", include={"nodes", "edges"})
    encoded = json.dumps(graph, separators=(",", ":"), ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_GRAPH_BYTES:
        raise FlowTooLargeError()
    return encoded


def _to_stored(snapshot: Any) -> StoredFlow:
    data = snapshot.to_dict()
    graph = json.loads(data["graph"])
    return StoredFlow(
        flow_id=snapshot.id,
        schema_version=data.get("schema_version", 1),
        name=data["name"],
        description=data.get("description", ""),
        nodes=graph["nodes"],
        edges=graph["edges"],
        created_at=data["created_at"],
        updated_at=data["updated_at"],
        version=data["version"],
    )


def _content_fields(flow: Flow) -> dict[str, Any]:
    return {
        "name": flow.name,
        "description": flow.description,
        "schema_version": flow.schema_version,
        "node_count": len(flow.nodes),
        "graph": _graph_json(flow),
    }


class FlowRepository:
    def __init__(self, db: firestore.AsyncClient) -> None:
        self._db = db
        self._collection = db.collection(COLLECTION)

    async def _owned_snapshot(self, owner_uid: str, flow_id: str, transaction: Any = None) -> Any:
        snapshot = await self._collection.document(flow_id).get(transaction=transaction)
        # Someone else's flow is reported exactly like a missing one: never leak existence.
        if not snapshot.exists or snapshot.get("owner_uid") != owner_uid:
            raise FlowNotFoundError()
        return snapshot

    async def list(self, owner_uid: str) -> list[FlowSummary]:
        query = (
            self._collection.where(filter=FieldFilter("owner_uid", "==", owner_uid))
            .order_by("updated_at", direction=firestore.Query.DESCENDING)
            .select(SUMMARY_FIELDS)
            .limit(LIST_LIMIT)
        )
        return [FlowSummary(flow_id=snap.id, **snap.to_dict()) async for snap in query.stream()]

    async def create(self, owner_uid: str, flow: Flow) -> StoredFlow:
        now = datetime.now(UTC)
        ref = self._collection.document()
        await ref.create(
            {
                "owner_uid": owner_uid,
                **_content_fields(flow),
                "version": 1,
                "created_at": now,
                "updated_at": now,
            }
        )
        return _to_stored(await ref.get())

    async def get(self, owner_uid: str, flow_id: str) -> StoredFlow:
        return _to_stored(await self._owned_snapshot(owner_uid, flow_id))

    async def _update(
        self,
        owner_uid: str,
        flow_id: str,
        fields: dict[str, Any],
        expected_version: int | None,
    ) -> StoredFlow:
        ref = self._collection.document(flow_id)

        @firestore.async_transactional
        async def run(transaction: Any) -> None:
            snapshot = await self._owned_snapshot(owner_uid, flow_id, transaction)
            current = snapshot.get("version")
            if expected_version is not None and expected_version != current:
                raise VersionConflictError(current_version=current)
            transaction.update(
                ref, {**fields, "version": current + 1, "updated_at": datetime.now(UTC)}
            )

        await run(self._db.transaction())
        return _to_stored(await ref.get())

    async def replace(
        self, owner_uid: str, flow_id: str, flow: Flow, expected_version: int | None
    ) -> StoredFlow:
        return await self._update(owner_uid, flow_id, _content_fields(flow), expected_version)

    async def update_meta(
        self,
        owner_uid: str,
        flow_id: str,
        *,
        name: str | None,
        description: str | None,
        expected_version: int | None,
    ) -> StoredFlow:
        fields = {
            k: v for k, v in {"name": name, "description": description}.items() if v is not None
        }
        return await self._update(owner_uid, flow_id, fields, expected_version)

    async def delete(self, owner_uid: str, flow_id: str) -> None:
        await self._owned_snapshot(owner_uid, flow_id)
        await self._collection.document(flow_id).delete()

    async def duplicate(self, owner_uid: str, flow_id: str) -> StoredFlow:
        original = await self.get(owner_uid, flow_id)
        copy = Flow(
            name=f"{original.name} (copy)"[:200],
            description=original.description,
            nodes=original.nodes,
            edges=original.edges,
        )
        return await self.create(owner_uid, copy)
