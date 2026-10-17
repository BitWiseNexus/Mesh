"""The Retriever node (app/nodes/executors/kb_retriever.py) with a fake knowledge service, and the
real one (app/services/knowledge.py) against the Firestore + Storage emulators."""

import asyncio
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.auth import AuthUser, get_current_user
from app.engine.compiler import compile_flow
from app.engine.executor import NodeError
from app.engine.runner import Runner
from app.main import app
from tests.conftest import requires_firestore_emulator, requires_storage_emulator
from tests.flows import edge, flow, node, tool_edge
from tests.knowledge import new_kb, upload
from tests.test_ingestion import wait_until_settled


class FakeKnowledge:
    def __init__(self, error: str | None = None) -> None:
        self.searches: list[tuple[str, str, int]] = []
        self.error = error

    async def search(self, knowledge_base_id: str, query: str, top_k: int) -> list[dict[str, Any]]:
        self.searches.append((knowledge_base_id, query, top_k))
        if self.error:
            raise NodeError(self.error)
        return [{"text": f"About {query}", "source": "faq.md", "page": None, "score": 0.9}]


def run(nodes: list[dict], edges: list[dict], knowledge: Any, input: str = "reset password"):
    events: list[dict] = []
    plan = compile_flow(flow(nodes, edges))
    runner = Runner(plan, run_id="r", input=input, sink=events.append, knowledge=knowledge)
    outcome = asyncio.run(runner.run())
    return outcome, events


def finished(events: list[dict], node_id: str) -> dict:
    return next(e for e in events if e["type"] == "node_finished" and e["node_id"] == node_id)


def test_as_a_step_it_searches_for_its_query() -> None:
    knowledge = FakeKnowledge()
    nodes = [
        node("t", "trigger_manual"),
        node("r", "kb_retriever", knowledge_base_id="kb1", query="How to {{input}}?", top_k=2),
        node("o", "output_display"),
    ]
    outcome, events = run(nodes, [edge("t", "r"), edge("r", "o")], knowledge)
    assert outcome.status == "succeeded"
    assert knowledge.searches == [("kb1", "How to reset password?", 2)]
    assert finished(events, "r")["output"] == [
        {"text": "About How to reset password?", "source": "faq.md", "page": None, "score": 0.9}
    ]
    assert any("Found 1 passage for" in e.get("message", "") for e in events)


def test_as_an_agent_tool_the_agent_writes_the_query() -> None:
    knowledge = FakeKnowledge()
    nodes = [
        node("t", "trigger_manual"),
        node("a", "agent_node", model="mock/tools"),  # calls each tool with the user message
        node("r", "kb_retriever", knowledge_base_id="kb1", query="ignored as a tool"),
        node("o", "output_display"),
    ]
    edges = [edge("t", "a"), edge("a", "o"), tool_edge("a", "r")]
    outcome, events = run(nodes, edges, knowledge)
    assert outcome.status == "succeeded"
    assert knowledge.searches == [("kb1", "reset password", 4)]
    call = next(e for e in events if e["type"] == "tool_call")
    assert call["arguments"] == {"query": "reset password"}
    assert "About reset password" in finished(events, "o")["output"]


@pytest.mark.parametrize(
    ("data", "knowledge", "message"),
    [
        ({"query": "  "}, FakeKnowledge(), "the query is empty"),
        ({}, FakeKnowledge(error="The knowledge base no longer exists"), "no longer exists"),
    ],
)
def test_problems_fail_the_node(data: dict, knowledge: FakeKnowledge, message: str) -> None:
    nodes = [node("t", "trigger_manual"), node("r", "kb_retriever", knowledge_base_id="kb", **data)]
    outcome, events = run(nodes, [edge("t", "r")], knowledge)
    assert outcome.status == "failed"
    assert message in finished(events, "r")["error"]


def test_without_a_knowledge_service_runs_explain_it() -> None:
    nodes = [node("t", "trigger_manual"), node("r", "kb_retriever", knowledge_base_id="kb")]
    outcome, events = run(nodes, [edge("t", "r")], None)
    assert "aren't available" in finished(events, "r")["error"]


# ── Real search (Firestore + Storage emulators, mock embeddings) ──────────


@pytest.fixture
def client(kb_client: TestClient) -> TestClient:
    return kb_client


DOCS = {
    "passwords.md": "To reset your password, open the login page and choose Forgot password.",
    "billing.md": "Invoices are emailed on the first day of each month with the amount due.",
    "shipping.md": "Orders ship within two business days from our warehouse.",
}


@requires_firestore_emulator
@requires_storage_emulator
class TestSearchThroughARun:
    def test_a_flow_finds_the_relevant_document(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        kb_id = new_kb(client)
        for name, text in DOCS.items():
            upload(client, kb_id, name, text.encode())
        wait_until_settled(client, kb_id)

        saved = client.post(
            "/flows",
            json={
                "name": "Ask the docs",
                "nodes": [
                    node("t", "trigger_manual", input="how do I reset my password"),
                    node("r", "kb_retriever", knowledge_base_id=kb_id, top_k=2),
                    node("o", "output_display"),
                ],
                "edges": [edge("t", "r"), edge("r", "o")],
            },
        ).json()
        run_info = client.post(f"/flows/{saved['flow_id']}/runs", json={}).json()
        result = self._wait_for_run(client, run_info["run_id"])
        assert result["status"] == "succeeded", result
        output = result["node_states"]["o"]["output"]
        assert [hit["source"] for hit in output][0] == "passwords.md"  # the closest first
        assert len(output) == 2 and output[0]["score"] > output[1]["score"]

        # Someone else's knowledge base can't be searched, even by id.
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="bob")
        bobs = client.post(
            "/flows",
            json={
                "name": "Snoop",
                "nodes": [
                    node("t", "trigger_manual", input="password"),
                    node("r", "kb_retriever", knowledge_base_id=kb_id),
                ],
                "edges": [edge("t", "r")],
            },
        ).json()
        snoop = client.post(f"/flows/{bobs['flow_id']}/runs", json={}).json()
        failed = self._wait_for_run(client, snoop["run_id"])
        assert failed["status"] == "failed"
        assert "no longer exists (or isn't yours)" in failed["node_states"]["r"]["error"]

    @staticmethod
    def _wait_for_run(client: TestClient, run_id: str) -> dict[str, Any]:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            info = client.get(f"/runs/{run_id}").json()
            if info["status"] in ("succeeded", "failed", "cancelled"):
                return info
            time.sleep(0.1)
        raise AssertionError(f"run still going: {info}")
