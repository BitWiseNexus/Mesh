import pytest
from pydantic import ValidationError

from app.schemas import EdgeType, Flow, NodeCategory, NodeType, category_of

# The example from the project specification, verbatim.
SPEC_EXAMPLE = {
    "flow_id": "flow_12345",
    "name": "Support Lead AI Assistant",
    "nodes": [
        {
            "id": "node_1",
            "type": "trigger_manual",
            "data": {"label": "Start Process"},
            "position": {"x": 100, "y": 200},
        },
        {
            "id": "node_2",
            "type": "agent_node",
            "data": {
                "model": "gpt-4o",
                "system_prompt": "You are a friendly customer support lead parser.",
                "tools": ["node_3"],
            },
            "position": {"x": 400, "y": 200},
        },
        {
            "id": "node_3",
            "type": "tool_web_search",
            "data": {"provider": "tavily"},
            "position": {"x": 400, "y": 400},
        },
    ],
    "edges": [
        {"id": "e1-2", "source": "node_1", "target": "node_2", "animated": True},
        {"id": "e2-3", "source": "node_2", "target": "node_3", "type": "tool_connection"},
    ],
}


def make_flow(**overrides) -> dict:
    return {**SPEC_EXAMPLE, **overrides}


def node(node_id: str, node_type: str = "agent_node") -> dict:
    return {"id": node_id, "type": node_type, "position": {"x": 0, "y": 0}}


def edge(edge_id: str, source: str, target: str, **extra) -> dict:
    return {"id": edge_id, "source": source, "target": target, **extra}


def test_spec_example_parses() -> None:
    flow = Flow.model_validate(SPEC_EXAMPLE)
    assert flow.flow_id == "flow_12345"
    assert [n.type for n in flow.nodes] == [
        NodeType.TRIGGER_MANUAL,
        NodeType.AGENT_NODE,
        NodeType.TOOL_WEB_SEARCH,
    ]
    assert flow.edges[0].type is EdgeType.DATA  # omitted type defaults to data
    assert flow.edges[0].animated is True
    assert flow.edges[1].type is EdgeType.TOOL_CONNECTION
    assert flow.node("node_3").data == {"provider": "tavily"}


def test_round_trip_uses_react_flow_field_names() -> None:
    raw = make_flow(
        nodes=[node("a", "logic_if"), node("b"), node("c")],
        edges=[
            edge("e1", "a", "b", sourceHandle="true"),
            edge("e2", "a", "c", sourceHandle="false"),
        ],
    )
    flow = Flow.model_validate(raw)
    assert flow.edges[0].source_handle == "true"

    dumped = flow.model_dump(mode="json")
    assert dumped["edges"][0]["sourceHandle"] == "true"
    assert "source_handle" not in dumped["edges"][0]
    assert Flow.model_validate(dumped) == flow


def test_new_empty_flow_is_valid() -> None:
    flow = Flow.model_validate({"name": "Untitled"})
    assert flow.flow_id is None
    assert flow.nodes == [] and flow.edges == []


@pytest.mark.parametrize("edge_type", [None, "", "default"])
def test_react_flow_default_edge_types_map_to_data(edge_type) -> None:
    raw = make_flow(nodes=[node("a"), node("b")], edges=[edge("e", "a", "b", type=edge_type)])
    assert Flow.model_validate(raw).edges[0].type is EdgeType.DATA


def test_react_flow_ui_fields_are_ignored() -> None:
    rf_node = {**node("a"), "measured": {"width": 200, "height": 80}, "selected": True}
    rf_edge = {**edge("e", "a", "b"), "selected": False, "style": {"stroke": "red"}}
    flow = Flow.model_validate(make_flow(nodes=[rf_node, node("b")], edges=[rf_edge]))
    assert "measured" not in flow.nodes[0].model_dump()


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        (make_flow(name=""), "at least 1 character"),
        (make_flow(nodes=[node("a", "not_a_node")], edges=[]), "Input should be"),
        (make_flow(nodes=[node("a"), node("a")], edges=[]), "duplicate node ids: ['a']"),
        (
            make_flow(
                nodes=[node("a"), node("b")],
                edges=[edge("e", "a", "b"), edge("e", "b", "a")],
            ),
            "duplicate edge ids: ['e']",
        ),
        (
            make_flow(nodes=[node("a")], edges=[edge("e", "a", "ghost")]),
            "unknown node(s): ['ghost']",
        ),
        (make_flow(nodes=[node("a")], edges=[edge("e", "a", "a")]), "to itself"),
        (
            make_flow(
                nodes=[node("a"), node("b")],
                edges=[edge("e1", "a", "b"), edge("e2", "a", "b")],
            ),
            "duplicates an existing connection",
        ),
        (
            make_flow(nodes=[node("a"), node("b")], edges=[edge("e", "a", "b", type="bogus")]),
            "Input should be",
        ),
    ],
    ids=[
        "empty-name",
        "unknown-node-type",
        "duplicate-node-id",
        "duplicate-edge-id",
        "dangling-edge",
        "self-loop",
        "duplicate-connection",
        "unknown-edge-type",
    ],
)
def test_invalid_flows_are_rejected(raw: dict, message: str) -> None:
    with pytest.raises(ValidationError) as exc:
        Flow.model_validate(raw)
    assert message in str(exc.value)


def test_same_endpoints_on_different_handles_are_allowed() -> None:
    raw = make_flow(
        nodes=[node("a", "logic_if"), node("b")],
        edges=[
            edge("e1", "a", "b", sourceHandle="true"),
            edge("e2", "a", "b", sourceHandle="false"),
        ],
    )
    assert len(Flow.model_validate(raw).edges) == 2


def test_cycles_are_structurally_allowed() -> None:
    raw = make_flow(
        nodes=[node("a"), node("b", "logic_loop")],
        edges=[edge("e1", "a", "b"), edge("e2", "b", "a")],
    )
    assert len(Flow.model_validate(raw).edges) == 2


def test_every_node_type_has_a_category() -> None:
    for node_type in NodeType:
        assert isinstance(category_of(node_type), NodeCategory)
    assert category_of(NodeType.HITL_APPROVAL) is NodeCategory.LOGIC
    assert category_of(NodeType.OUTPUT_DISPLAY) is NodeCategory.ACTION


def test_node_refs_round_trip_and_are_optional() -> None:
    raw = make_flow(nodes=[{**node("a"), "ref": "agent"}, node("b")], edges=[])
    flow = Flow.model_validate(raw)
    assert flow.node("a").ref == "agent"
    assert flow.node("b").ref is None
    assert flow.model_dump(mode="json")["nodes"][0]["ref"] == "agent"


@pytest.mark.parametrize(
    ("refs", "message"),
    [
        (["agent", "agent"], "duplicate node refs: ['agent']"),
        (["input", "b"], "reserved node refs: ['input']"),
        (["b", "x"], "equal another node's id: ['b']"),
        (["Agent", "x"], "String should match pattern"),
        (["9lives", "x"], "String should match pattern"),
        (["a" * 41, "x"], "String should match pattern"),
    ],
    ids=["duplicate", "reserved", "clashes-with-id", "uppercase", "leading-digit", "too-long"],
)
def test_invalid_node_refs_are_rejected(refs: list[str], message: str) -> None:
    nodes = [{**node("a"), "ref": refs[0]}, {**node("b"), "ref": refs[1]}]
    with pytest.raises(ValidationError) as exc:
        Flow.model_validate(make_flow(nodes=nodes, edges=[]))
    assert message in str(exc.value)
