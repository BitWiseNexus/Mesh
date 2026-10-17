"""Turning a document into chunks: text extraction (PDF, plain text, Markdown) and splitting.

Chunks are measured in characters (the knowledge base's `chunk_size` / `chunk_overlap`). Splits
prefer natural boundaries — a paragraph, then a line, a sentence, a word — in the second half of
the window, so chunks rarely cut words or sentences; the overlap repeats the end of one chunk at
the start of the next, so a passage spanning the boundary is still found.
"""

import io
import logging
import re
from dataclasses import dataclass

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from app.services.documents import PDF

logger = logging.getLogger("app.services.chunking")


class ExtractionError(Exception):
    """The document's text couldn't be read; the message is meant for the user."""


@dataclass(frozen=True)
class Page:
    #: 1-based; None for formats without pages.
    number: int | None
    text: str


@dataclass(frozen=True)
class Chunk:
    index: int
    text: str
    #: The page the chunk starts on (PDFs).
    page: int | None


def extract_pages(data: bytes, mime: str) -> list[Page]:
    """The document's text, page by page (one "page" for text formats)."""
    if mime != PDF:
        return [Page(None, data.decode("utf-8-sig"))]
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            raise ExtractionError("This PDF is password-protected.")
        pages = [Page(i + 1, page.extract_text() or "") for i, page in enumerate(reader.pages)]
    except ExtractionError:
        raise
    except (PdfReadError, ValueError, KeyError, TypeError) as exc:
        logger.info("Unreadable PDF: %s", exc)
        raise ExtractionError("This PDF couldn't be read (it may be damaged).") from exc
    if not any(p.text.strip() for p in pages):
        raise ExtractionError(
            "No text found in this PDF. Scanned PDFs (images of pages) aren't supported yet."
        )
    return pages


_SPACES = re.compile(r"[ \t\f\v]+")
_BLANK_LINES = re.compile(r"\n{3,}")


def normalize(text: str) -> str:
    """Tidies whitespace without losing structure: runs of spaces → one, ≥ 3 newlines → 2."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _SPACES.sub(" ", text)
    text = "\n".join(line.strip() for line in text.split("\n"))
    return _BLANK_LINES.sub("\n\n", text).strip()


# Where a chunk may end, best first. A match ends the chunk *after* the separator.
_BREAKS = ("\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ")


def _break_at(text: str, start: int, end: int) -> int:
    """The best place to end a chunk that would run from `start` to `end` (exclusive)."""
    lowest = start + (end - start) // 2  # never make a chunk shorter than half the size
    for separator in _BREAKS:
        found = text.rfind(separator, lowest, end)
        if found != -1:
            return found + len(separator)
    return end  # one long "word": cut it


def split_text(text: str, size: int, overlap: int) -> list[str]:
    """Chunks of at most `size` characters; each starts `overlap` characters (moved forward to a
    word start) before the previous one ended."""
    if not 0 <= overlap < size:
        raise ValueError("overlap must be smaller than size")
    text = text.strip()
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = len(text) if len(text) - start <= size else _break_at(text, start, start + size)
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(text):
            break
        next_start = max(end - overlap, start + 1)
        # Don't start in the middle of a word.
        while 0 < next_start < end and not text[next_start - 1].isspace():
            next_start += 1
        start = next_start
    return chunks


def chunk_pages(pages: list[Page], size: int, overlap: int) -> list[Chunk]:
    """Splits the whole document (pages joined by blank lines) and notes each chunk's page."""
    texts: list[str] = []
    starts: list[tuple[int, int | None]] = []  # (offset in the joined text, page number)
    offset = 0
    for page in pages:
        text = normalize(page.text)
        if not text:
            continue
        starts.append((offset, page.number))
        texts.append(text)
        offset += len(text) + 2
    joined = "\n\n".join(texts)

    chunks: list[Chunk] = []
    position = 0
    for text in split_text(joined, size, overlap):
        found = joined.find(text, position)
        at = found if found != -1 else position
        page = next((number for begin, number in reversed(starts) if begin <= at), None)
        chunks.append(Chunk(index=len(chunks), text=text, page=page))
        position = at + 1
    return chunks
