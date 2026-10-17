"""Text extraction and chunking (app/services/chunking.py)."""

import pytest

from app.services.chunking import (
    ExtractionError,
    Page,
    chunk_pages,
    extract_pages,
    normalize,
    split_text,
)
from tests.pdfs import make_pdf

SENTENCES = " ".join(f"Sentence number {i} says something useful." for i in range(60))


def test_extracts_text_pages_and_pdf_pages() -> None:
    assert extract_pages("\ufeffHello\nworld".encode(), "text/markdown") == [
        Page(None, "Hello\nworld")
    ]
    pages = extract_pages(make_pdf(["First page", "", "Third (page)"]), "application/pdf")
    assert [p.number for p in pages] == [1, 2, 3]
    assert "First page" in pages[0].text and "Third (page)" in pages[2].text
    assert pages[1].text.strip() == ""


def test_pdfs_without_text_or_damaged_ones_are_explained() -> None:
    with pytest.raises(ExtractionError, match="Scanned PDFs"):
        extract_pages(make_pdf(["", ""]), "application/pdf")
    with pytest.raises(ExtractionError, match="couldn't be read"):
        extract_pages(b"%PDF-1.4\nnot really a pdf", "application/pdf")


def test_normalize_keeps_paragraphs_but_tidies_spaces() -> None:
    assert normalize("  a \t  b\r\n\r\n\r\n\n c  \n") == "a b\n\nc"


def test_chunks_respect_the_size_and_overlap() -> None:
    chunks = split_text(SENTENCES, 200, 50)
    assert all(len(c) <= 200 for c in chunks)
    assert all(len(c) >= 100 for c in chunks[:-1])  # never less than half the size
    # Every chunk ends at a sentence boundary (the text has no better breaks).
    assert all(c.endswith(".") for c in chunks)
    # Consecutive chunks overlap: the next one starts with words from the end of the previous.
    for previous, current in zip(chunks, chunks[1:], strict=False):
        first_word = current.split()[0]
        assert first_word in previous[-60:]
    # Nothing is lost: every sentence appears somewhere.
    assert all(f"number {i} " in " ".join(chunks) for i in range(60))


def test_chunks_prefer_paragraphs_then_lines() -> None:
    text = "Alpha " * 20 + "\n\n" + "Beta " * 20 + "\n" + "Gamma " * 20
    chunks = split_text(text, 200, 0)
    assert chunks[0].endswith("Alpha") and chunks[1].startswith("Beta")


def test_long_words_are_cut_and_progress_is_always_made() -> None:
    word = "x" * 1000
    chunks = split_text(word, 200, 150)
    assert "".join(c[:50] for c in chunks)  # finishes
    assert all(len(c) <= 200 for c in chunks)
    assert chunks[0] == "x" * 200
    assert split_text("", 200, 0) == []
    assert split_text("short", 200, 50) == ["short"]
    with pytest.raises(ValueError):
        split_text("abc", 100, 100)


def test_chunk_pages_notes_each_chunks_page() -> None:
    pages = [Page(1, "Intro " * 30), Page(2, "   "), Page(3, "Details " * 60)]
    chunks = chunk_pages(pages, 200, 0)
    assert [c.index for c in chunks] == list(range(len(chunks)))
    assert chunks[0].page == 1
    assert chunks[-1].page == 3
    assert {c.page for c in chunks} == {1, 3}  # the blank page has nothing
    assert chunk_pages([Page(None, "Just text")], 200, 50)[0].page is None
