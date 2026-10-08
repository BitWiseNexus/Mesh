"""Encryption of secrets at rest (users' saved API keys), with Fernet (AES-128-CBC + HMAC).

Keys come from CREDENTIALS_ENCRYPTION_KEY: comma-separated Fernet keys, the first one encrypts and
every one decrypts, so keys can be rotated. Generate one with:

    uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

Production refuses to start without it (checked at startup). Development falls back to a fixed
key derived from a public string — fine for emulator data, useless for real secrets.
"""

import base64
import hashlib
import logging
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from app.core.config import get_settings

logger = logging.getLogger(__name__)

_DEV_KEY = base64.urlsafe_b64encode(hashlib.sha256(b"mesh-development-only").digest())


class DecryptionError(Exception):
    """A stored secret can't be decrypted (wrong or rotated-away key, or corrupted data)."""


@lru_cache
def get_cipher() -> MultiFernet:
    settings = get_settings()
    configured = settings.credentials_encryption_key
    if configured is None:
        if settings.environment == "production":
            raise RuntimeError(
                "CREDENTIALS_ENCRYPTION_KEY must be set in production (it encrypts saved API keys)"
            )
        logger.warning("CREDENTIALS_ENCRYPTION_KEY isn't set: using the insecure development key")
        return MultiFernet([Fernet(_DEV_KEY)])
    keys = [k.strip() for k in configured.get_secret_value().split(",") if k.strip()]
    try:
        return MultiFernet([Fernet(k) for k in keys])
    except ValueError as exc:
        raise RuntimeError(f"CREDENTIALS_ENCRYPTION_KEY is invalid: {exc}") from exc


def encrypt(plaintext: str) -> str:
    return get_cipher().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> str:
    try:
        return get_cipher().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise DecryptionError("This secret can't be decrypted with the configured keys") from exc
