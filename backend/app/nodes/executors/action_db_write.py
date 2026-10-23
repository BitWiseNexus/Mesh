"""Database Write: adds or updates a row in one of the user's tables (app/services/tables.py).

The Row field becomes an object:
- a single reference to an object (`{{input}}`, `{{webhook.output.body}}`) → that object;
- JSON written around references (`{"name": "{{webhook.output.body.name}}"}`) → parsed, with
  each value escaped into it (quotes in a value can't break the JSON);
- anything else (text, a number, a list, JSON text that isn't an object) → `{"value": …}`.
"""

import json
from typing import Any

from app.engine.context import NodeContext
from app.engine.escaping import escape_json_strings, looks_like_json
from app.engine.executor import NodeError, NodeResult, executor
from app.schemas.node_types import NodeType


def _row(ctx: NodeContext) -> dict[str, Any]:
    template = str(ctx.data.get("row") or "")
    written_as_json = looks_like_json(template) and not template.strip().startswith("{{")
    value = ctx.value(template, escape_json_strings if written_as_json else None)
    if isinstance(value, str):
        if written_as_json:
            try:
                value = json.loads(value)
            except json.JSONDecodeError as exc:
                raise NodeError(
                    f"The row isn't valid JSON ({exc.msg}, line {exc.lineno} column {exc.colno})"
                ) from None
        elif value.strip().startswith("{"):  # e.g. an agent that answered in JSON
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                pass
    if value is None or value == "":
        raise NodeError("Nothing to write: the row is empty")
    return value if isinstance(value, dict) else {"value": value}


@executor(NodeType.ACTION_DB_WRITE)
async def db_write(ctx: NodeContext) -> NodeResult:
    row = _row(ctx)
    written = await ctx.run.tables.write_row(
        ctx.field("table"),
        row,
        row_id=ctx.field("row_id").strip() or None,
        merge=ctx.data.get("merge") is True,
        flow_id=ctx.run.plan.flow_id,
        run_id=ctx.run.run_id,
    )
    verb = "Added" if written["created"] else "Updated"
    ctx.log(f"{verb} row {written['row_id']} in “{written['table']}”")
    return NodeResult(written)
