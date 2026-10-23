"""Tables (Database Write node, `/tables`): each user's own rows of JSON, written by their flows."""

import re
from datetime import datetime
from typing import Any

from pydantic import BaseModel

#: Must match MAX_* in frontend/src/types/tables.ts.
MAX_TABLES_PER_USER = 100
MAX_ROWS_PER_TABLE = 10_000
#: A row's JSON, in characters.
MAX_ROW_CHARS = 100_000
MAX_TABLE_NAME = 64
MAX_ROW_ID = 100

_TABLE_NAME = re.compile(r"^[\w .-]+$")


def clean_table_name(name: str) -> str:
    """The name with spaces tidied; ValueError (a user-facing message) when it can't be one."""
    name = " ".join(name.split())
    if not name:
        raise ValueError("No table: “Table” is empty")
    if len(name) > MAX_TABLE_NAME:
        raise ValueError(f"The table name is too long (at most {MAX_TABLE_NAME} characters)")
    if not _TABLE_NAME.match(name):
        raise ValueError(
            f"“{name}” can't be a table name: use letters, digits, spaces, “-”, “_” and “.”"
        )
    return name


def clean_row_id(row_id: str) -> str:
    row_id = row_id.strip()
    if len(row_id) > MAX_ROW_ID:
        raise ValueError(f"The row ID is too long (at most {MAX_ROW_ID} characters)")
    if "/" in row_id or row_id in (".", "..") or row_id.startswith("__"):
        raise ValueError(f"“{row_id}” can't be a row ID (no “/”, and not “.”, “..” or “__…”)")
    return row_id


class TableInfo(BaseModel):
    table_id: str
    name: str
    row_count: int
    created_at: datetime
    updated_at: datetime


class RowInfo(BaseModel):
    row_id: str
    data: dict[str, Any]
    created_at: datetime
    updated_at: datetime
    #: What wrote it last.
    flow_id: str | None = None
    run_id: str | None = None
