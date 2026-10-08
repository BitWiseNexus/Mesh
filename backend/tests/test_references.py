import json
from dataclasses import asdict
from pathlib import Path

import pytest

from app.engine.references import (
    InputPart,
    RefPart,
    format_reference,
    parse_template,
    referenced_nodes,
    rename_references,
)

# Shared with the frontend's parser tests — both must agree exactly.
CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "shared" / "template-cases.json").read_text("utf-8")
)


@pytest.mark.parametrize("case", CASES["parse"], ids=lambda c: repr(c["text"])[:50])
def test_parse_shared_cases(case: dict) -> None:
    assert [asdict(p) for p in parse_template(case["text"])] == case["parts"]


@pytest.mark.parametrize("case", CASES["rename"], ids=lambda c: repr(c["text"])[:50])
def test_rename_shared_cases(case: dict) -> None:
    assert rename_references(case["text"], case["from"], case["to"]) == case["result"]


def test_format_round_trips() -> None:
    assert parse_template(format_reference("agent", ["items", "0"])) == [
        RefPart("agent", ["items", "0"])
    ]
    assert parse_template("{{input}}") == [InputPart()]


def test_referenced_nodes_are_unique_and_ordered() -> None:
    assert referenced_nodes("{{b.output}} {{a.output.x}} {{b.output.y}} {{input}}") == ["b", "a"]
