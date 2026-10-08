import pytest
from pydantic import ValidationError

from app.nodes.catalog import CATALOG, IN, OUT, TOOL, FieldSpec, NodeSpec, OptionSpec
from app.nodes.export_catalog import FRONTEND_CATALOG, render_catalog
from app.schemas.node_types import NodeCategory, NodeType


def test_every_node_type_has_a_spec() -> None:
    assert set(CATALOG) == set(NodeType)
    for node_type, spec in CATALOG.items():
        assert spec.type is node_type


@pytest.mark.skipif(not FRONTEND_CATALOG.exists(), reason="frontend not checked out")
def test_frontend_catalog_is_up_to_date() -> None:
    """The frontend reads a generated copy of the catalog; it must never drift."""
    assert FRONTEND_CATALOG.read_text(encoding="utf-8") == render_catalog(), (
        "frontend/src/lib/nodes/catalog.json is stale - run: "
        "uv run python -m app.nodes.export_catalog"
    )


def test_render_uses_camel_case_and_omits_unset_options() -> None:
    rendered = render_catalog()
    assert '"defaultData"' in rendered and '"comingSoon"' in rendered
    assert '"default_data"' not in rendered
    assert '"suggestions": null' not in rendered


def spec(**overrides) -> NodeSpec:
    base = dict(
        type=NodeType.AGENT_NODE,
        category=NodeCategory.AGENT,
        label="Agent",
        ref_prefix="agent",
        description="d",
        inputs=[IN],
        outputs=[OUT],
        default_data={"model": "x"},
        fields=[FieldSpec(key="model", label="Model", kind="text")],
    )
    return NodeSpec(**{**base, **overrides})


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"category": NodeCategory.TOOL}, "doesn't match its type"),
        ({"default_data": {}}, "without a default value"),
        ({"outputs": [OUT, OUT]}, "duplicate handle ids"),
        ({"ref_prefix": "input"}, "is reserved"),
        (
            {
                "type": NodeType.TOOL_HTTP,
                "category": NodeCategory.TOOL,
                "inputs": [TOOL],
                "outputs": [OUT],
            },
            "only have a 'tool' input",
        ),
        (
            {
                "default_data": {"model": "nope"},
                "fields": [
                    FieldSpec(
                        key="model",
                        label="M",
                        kind="select",
                        options=[OptionSpec(value="a", label="A")],
                    )
                ],
            },
            "isn't an option",
        ),
    ],
)
def test_inconsistent_specs_are_rejected(overrides: dict, message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        spec(**overrides)


@pytest.mark.parametrize(
    ("field", "message"),
    [
        ({"kind": "select"}, "needs options"),
        ({"kind": "code"}, "needs a language"),
        ({"kind": "number", "min": 5, "max": 1}, "min > max"),
        ({"kind": "number", "templated": True}, "only text fields can be templated"),
    ],
)
def test_inconsistent_fields_are_rejected(field: dict, message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        FieldSpec(key="k", label="K", **field)
