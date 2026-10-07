"""Firebase Admin initialisation (emulator-aware) and shared clients."""

import os
from functools import lru_cache

import firebase_admin
from firebase_admin import credentials, firestore_async
from firebase_admin import storage as admin_storage
from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore, storage

from app.core.config import get_settings


def _bucket_name() -> str:
    settings = get_settings()
    return settings.firebase_storage_bucket or f"{settings.firebase_project_id}.appspot.com"


def init_firebase() -> firebase_admin.App:
    """Initialise the default Firebase app once. Safe to call repeatedly."""
    if firebase_admin._apps:
        return firebase_admin.get_app()

    settings = get_settings()
    if settings.use_firebase_emulators:
        # The Google SDKs pick these up and switch to the local emulators.
        os.environ["FIRESTORE_EMULATOR_HOST"] = settings.firestore_emulator_host
        os.environ["FIREBASE_AUTH_EMULATOR_HOST"] = settings.firebase_auth_emulator_host
        os.environ["STORAGE_EMULATOR_HOST"] = f"http://{settings.firebase_storage_emulator_host}"

    credential = (
        credentials.Certificate(settings.firebase_credentials_path)
        if settings.firebase_credentials_path
        else None
    )
    return firebase_admin.initialize_app(
        credential,
        {
            "projectId": settings.firebase_project_id,
            "storageBucket": _bucket_name(),
        },
    )


@lru_cache
def get_db() -> firestore.AsyncClient:
    """Async Firestore client."""
    settings = get_settings()
    init_firebase()
    if settings.use_firebase_emulators:
        # firebase_admin would demand Application Default Credentials here; the raw client uses
        # anonymous credentials automatically when FIRESTORE_EMULATOR_HOST is set.
        return firestore.AsyncClient(project=settings.firebase_project_id)
    return firestore_async.client()


@lru_cache
def get_bucket() -> storage.Bucket:
    """Default Cloud Storage bucket."""
    settings = get_settings()
    init_firebase()
    if settings.use_firebase_emulators:
        # Same ADC problem as Firestore; STORAGE_EMULATOR_HOST routes this client to the emulator.
        client = storage.Client(
            project=settings.firebase_project_id, credentials=AnonymousCredentials()
        )
        return client.bucket(_bucket_name())
    return admin_storage.bucket()
