"""Firestore persistence for saved API keys. Every method is scoped to the owner's uid.

Document `credentials/{credential_id}`:
    owner_uid, provider, name, hint, secret (encrypted, app/core/crypto.py),
    created_at, updated_at

Security rules deny every client read and write: the backend is the only reader, and it never
returns `secret`.
"""

from datetime import UTC, datetime
from typing import Any

from google.cloud import firestore
from google.cloud.firestore_v1 import FieldFilter

from app.core.crypto import decrypt, encrypt
from app.core.errors import ApiError, NotFoundError
from app.schemas.credentials import CredentialCreate, CredentialInfo, CredentialUpdate

COLLECTION = "credentials"
MAX_PER_USER = 50


class CredentialNotFoundError(NotFoundError):
    code = "credential_not_found"
    message = "API key not found."


class TooManyCredentialsError(ApiError):
    status_code = 409
    code = "too_many_credentials"
    message = f"You can save up to {MAX_PER_USER} API keys. Delete one first."


def hint_for(value: str) -> str:
    return f"…{value[-4:]}" if len(value) >= 8 else "…"


def _to_info(snapshot: Any) -> CredentialInfo:
    data = snapshot.to_dict()
    return CredentialInfo(
        credential_id=snapshot.id,
        provider=data["provider"],
        name=data["name"],
        hint=data["hint"],
        created_at=data["created_at"],
        updated_at=data["updated_at"],
    )


class CredentialRepository:
    def __init__(self, db: firestore.AsyncClient) -> None:
        self._collection = db.collection(COLLECTION)

    def _owned_query(self, owner_uid: str) -> Any:
        return self._collection.where(filter=FieldFilter("owner_uid", "==", owner_uid))

    async def _owned_snapshot(self, owner_uid: str, credential_id: str) -> Any:
        snapshot = await self._collection.document(credential_id).get()
        # Someone else's key is reported exactly like a missing one.
        if not snapshot.exists or snapshot.get("owner_uid") != owner_uid:
            raise CredentialNotFoundError()
        return snapshot

    async def list(self, owner_uid: str) -> list[CredentialInfo]:
        """Newest first. (Sorted here: at most MAX_PER_USER, and no composite index needed.)"""
        query = self._owned_query(owner_uid).select(
            ["provider", "name", "hint", "created_at", "updated_at"]
        )
        found = [_to_info(s) async for s in query.stream()]
        return sorted(found, key=lambda c: c.created_at, reverse=True)

    async def create(self, owner_uid: str, body: CredentialCreate) -> CredentialInfo:
        existing = await self._owned_query(owner_uid).count().get()
        if existing[0][0].value >= MAX_PER_USER:
            raise TooManyCredentialsError()
        now = datetime.now(UTC)
        ref = self._collection.document()
        await ref.create(
            {
                "owner_uid": owner_uid,
                "provider": body.provider.value,
                "name": body.name.strip(),
                "hint": hint_for(body.value),
                "secret": encrypt(body.value),
                "created_at": now,
                "updated_at": now,
            }
        )
        return _to_info(await ref.get())

    async def update(
        self, owner_uid: str, credential_id: str, body: CredentialUpdate
    ) -> CredentialInfo:
        await self._owned_snapshot(owner_uid, credential_id)
        fields: dict[str, Any] = {"updated_at": datetime.now(UTC)}
        if body.name is not None:
            fields["name"] = body.name.strip()
        if body.value is not None:
            fields |= {"secret": encrypt(body.value), "hint": hint_for(body.value)}
        ref = self._collection.document(credential_id)
        await ref.update(fields)
        return _to_info(await ref.get())

    async def delete(self, owner_uid: str, credential_id: str) -> None:
        await self._owned_snapshot(owner_uid, credential_id)
        await self._collection.document(credential_id).delete()

    # ── For runs (secrets in plaintext: never return these from the API) ─────────

    async def secret(self, owner_uid: str, credential_id: str) -> tuple[str, str] | None:
        """(provider, plaintext) of one of the owner's keys, or None."""
        try:
            snapshot = await self._owned_snapshot(owner_uid, credential_id)
        except CredentialNotFoundError:
            return None
        return snapshot.get("provider"), decrypt(snapshot.get("secret"))

    async def latest_secret(self, owner_uid: str, provider: str) -> str | None:
        """The owner's most recently saved key for `provider`, or None."""
        query = self._owned_query(owner_uid).where(filter=FieldFilter("provider", "==", provider))
        snapshots = [s async for s in query.stream()]
        if not snapshots:
            return None
        newest = max(snapshots, key=lambda s: s.get("updated_at"))
        return decrypt(newest.get("secret"))
