"""Writes the node catalog for the frontend.

uv run python -m app.nodes.export_catalog          # write frontend/src/lib/nodes/catalog.json
uv run python -m app.nodes.export_catalog --check  # exit 1 if the committed file is stale
"""

import json
import sys
from pathlib import Path

from app.nodes.catalog import CATALOG
from app.schemas.node_types import NodeType

FRONTEND_CATALOG = (
    Path(__file__).resolve().parents[3] / "frontend" / "src" / "lib" / "nodes" / "catalog.json"
)


def render_catalog() -> str:
    """The catalog as stable, pretty JSON (NodeType order; unset optional fields omitted)."""
    payload = {
        "$comment": (
            "GENERATED from backend/app/nodes/catalog.py by "
            "`uv run python -m app.nodes.export_catalog`. Do not edit by hand."
        ),
        "nodes": [
            CATALOG[t].model_dump(mode="json", by_alias=True, exclude_none=True) for t in NodeType
        ],
    }
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    rendered = render_catalog()
    if "--check" in argv:
        current = FRONTEND_CATALOG.read_text(encoding="utf-8") if FRONTEND_CATALOG.exists() else ""
        if current != rendered:
            print(f"{FRONTEND_CATALOG} is stale. Regenerate it with:")
            print("    uv run python -m app.nodes.export_catalog")
            return 1
        print("Node catalog is up to date.")
        return 0
    FRONTEND_CATALOG.write_text(rendered, encoding="utf-8", newline="\n")
    print(f"Wrote {FRONTEND_CATALOG}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
