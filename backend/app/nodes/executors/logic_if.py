"""If / Else: checks a condition and continues on the True or the False output."""

import math
from typing import Any

from app.engine.context import NodeContext, to_text
from app.engine.executor import NodeError, NodeResult, executor
from app.schemas.node_types import NodeType

LABELS = {
    "equals": "equals",
    "not_equals": "does not equal",
    "contains": "contains",
    "not_contains": "does not contain",
    "greater_than": "is greater than",
    "less_than": "is less than",
    "is_empty": "is empty",
    "is_not_empty": "is not empty",
}


def as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip().replace(",", ""))
        except ValueError:
            return None
    else:
        return None
    return number if math.isfinite(number) else None


def _norm(value: Any) -> str:
    """Text comparisons ignore case and surrounding whitespace (models vary: "Yes" / "yes ")."""
    return to_text(value).strip().casefold()


def is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    return isinstance(value, list | dict) and len(value) == 0


def evaluate(left: Any, operator: str, right: str) -> bool:
    """Whether `left <operator> right` holds. `left` may be any value (a whole output), `right`
    is the rendered "Compare to" text."""
    match operator:
        case "equals" | "not_equals":
            a, b = as_number(left), as_number(right)
            same = a == b if a is not None and b is not None else _norm(left) == _norm(right)
            return same if operator == "equals" else not same
        case "contains" | "not_contains":
            if isinstance(left, list):
                found = any(_norm(item) == _norm(right) for item in left)
            else:
                found = _norm(right) in _norm(left)
            return found if operator == "contains" else not found
        case "greater_than" | "less_than":
            a, b = as_number(left), as_number(right)
            if a is None or b is None:
                bad = to_text(left) if a is None else right
                raise NodeError(
                    f"“{LABELS[operator]}” compares numbers, but “{bad[:80]}” isn't a number"
                )
            return a > b if operator == "greater_than" else a < b
        case "is_empty":
            return is_empty(left)
        case "is_not_empty":
            return not is_empty(left)
    raise NodeError(f"Unknown operator “{operator}”")


@executor(NodeType.LOGIC_IF)
async def logic_if(ctx: NodeContext) -> NodeResult:
    operator = str(ctx.data.get("operator") or "equals")
    left = ctx.value(str(ctx.data.get("field") or ""))
    right = ctx.render(str(ctx.data.get("value") or ""))
    result = evaluate(left, operator, right)
    shown = to_text(left).strip().replace("\n", " ")
    shown = shown if len(shown) <= 60 else f"{shown[:60]}…"
    comparison = "" if operator in ("is_empty", "is_not_empty") else f" “{right.strip()}”"
    ctx.log(f"“{shown}” {LABELS.get(operator, operator)}{comparison} → {str(result).lower()}")
    # The input passes through unchanged, on the branch that was taken.
    return NodeResult(ctx.input, handles=("true",) if result else ("false",))
