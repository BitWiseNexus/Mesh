"""Knowledge-base document files: what can be uploaded, and where it's stored.

Files live in Cloud Storage at `knowledge_bases/{owner_uid}/{knowledge_base_id}/{document_id}`
(never readable by clients: storage rules deny everything; the backend writes through the Admin
SDK). Their Firestore records are in `knowledge_bases/{id}/documents` (repositories/knowledge.py).
"""

import asyncio
import logging
import posixpath
from dataclasses import dataclass

from google.api_core import exceptions as google_errors

from app.core.errors import ApiError, PayloadTooLargeError
from app.core.firebase import get_bucket
from app.schemas.knowledge import MAX_DOCUMENT_BYTES, MAX_DOCUMENT_NAME_LENGTH

logger = logging.getLogger(__name__)

PDF = "application/pdf"
TEXT = "text/plain"
MARKDOWN = "text/markdown"
_TYPES = {".pdf": PDF, ".txt": TEXT, ".text": TEXT, ".md": MARKDOWN, ".markdown": MARKDOWN}


class UnsupportedDocumentError(ApiError):
    status_code = 415
    code = "unsupported_document_type"
    message = "Upload PDF, plain-text (.txt) or Markdown (.md) files."


class DocumentTooLargeError(PayloadTooLargeError):
    code = "document_too_large"
    message = f"Documents can be at most {MAX_DOCUMENT_BYTES // (1024 * 1024)} MB."


class EmptyDocumentError(ApiError):
    status_code = 422
    code = "empty_document"
    message = "That file is empty."


@dataclass(frozen=True)
class CheckedFile:
    name: str
    mime: str
    data: bytes


def check_file(filename: str | None, data: bytes) -> CheckedFile:
    """The upload as Mesh will store it: a clean file name and a type it can process — decided by
    the extension *and* the content (a renamed binary isn't text, a .pdf must be a PDF)."""
    name = posixpath.basename((filename or "").replace("\\", "/")).strip()
    if not name:
        raise UnsupportedDocumentError("The file needs a name.")
    if len(data) > MAX_DOCUMENT_BYTES:
        raise DocumentTooLargeError()
    if not data:
        raise EmptyDocumentError()
    mime = _TYPES.get(posixpath.splitext(name)[1].lower())
    if mime is None:
        raise UnsupportedDocumentError()
    if mime == PDF:
        if not data.startswith(b"%PDF-"):
            raise UnsupportedDocumentError(f"“{name}” isn't a valid PDF file.")
    else:
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise UnsupportedDocumentError(f"“{name}” isn't UTF-8 text.") from None
        if "\x00" in text:
            raise UnsupportedDocumentError(f"“{name}” looks like a binary file, not text.")
    return CheckedFile(name=name[:MAX_DOCUMENT_NAME_LENGTH], mime=mime, data=data)


def folder(owner_uid: str, knowledge_base_id: str) -> str:
    return f"knowledge_bases/{owner_uid}/{knowledge_base_id}/"


def file_path(owner_uid: str, knowledge_base_id: str, document_id: str) -> str:
    return folder(owner_uid, knowledge_base_id) + document_id


async def save_file(path: str, file: CheckedFile) -> None:
    def upload() -> None:
        blob = get_bucket().blob(path)
        blob.metadata = {"name": file.name}
        blob.upload_from_string(file.data, content_type=file.mime)

    await asyncio.to_thread(upload)


async def read_file(path: str) -> bytes:
    return await asyncio.to_thread(lambda: get_bucket().blob(path).download_as_bytes())


async def delete_file(path: str) -> None:
    """Best effort: a file that's already gone is fine; other failures are logged, not raised
    (the record is already deleted — an orphaned file only costs storage)."""

    def delete() -> None:
        try:
            get_bucket().blob(path).delete()
        except google_errors.NotFound:
            pass

    try:
        await asyncio.to_thread(delete)
    except Exception:
        logger.exception("Couldn't delete %s from storage", path)


async def delete_folder(prefix: str) -> None:
    """Deletes every file under `prefix` (best effort, like `delete_file`)."""

    def delete() -> None:
        bucket = get_bucket()
        for blob in bucket.list_blobs(prefix=prefix):
            try:
                blob.delete()
            except google_errors.NotFound:
                pass

    try:
        await asyncio.to_thread(delete)
    except Exception:
        logger.exception("Couldn't delete %s* from storage", prefix)
