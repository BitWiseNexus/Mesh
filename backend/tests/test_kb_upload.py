"""The "Add to Knowledge Base" node (app/nodes/executors/kb_upload.py): with a fake knowledge
service, and for real (Firestore + Storage emulators, mock embeddings) — store, then retrieve in
the same run."""

import asyncio
import time
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.engine.compiler import compile_flow
from app.engine.executor import NodeError
from app.engine.runner import Runner
from app.nodes.executors.kb_upload import document_name
from tests.conftest import requires_firestore_emulator, requires_storage_emulator
from tests.flows import edge, flow, node
from tests.knowledge import new_kb

NOW = datetime(2026, 10, 17, 9, 5, tzinfo=UTC)


@pytest.mark.parametrize(
    ("title", "name"),
    [
        ("Meeting notes", "Meeting notes.md"),
        ("  summary.txt ", "summary.txt"),
        ("Q3 / Q4\nplan", "Q3 - Q4 plan.md"),
        ("", "Run output 2026-10-17 09:05 UTC.md"),
    ],
)
def test_document_names(title: str, name: str) -> None:
    assert document_name(title, NOW) == name


class FakeKnowledge:
    def __init__(self, error: str | None = None) -> None:
        self.added: list[tuple[str, str, str]] = []
        self.error = error

    async def search(self, knowledge_base_id: str, query: str, top_k: int) -> list[dict]:
        return []

    async def add_document(self, knowledge_base_id: str, name: str, text: str) -> dict[str, Any]:
        if self.error:
            raise NodeError(self.error)
        self.added.append((knowledge_base_id, name, text))
        return {"document_id": "d1", "name": name, "knowledge_base_id": "kb", "chunk_count": 1}


def run(data: dict[str, Any], knowledge: FakeKnowledge) -> tuple[Any, list[dict]]:
    events: list[dict] = []
    plan = compile_flow(
        flow(
            [node("t", "trigger_manual"), node("k", "kb_upload", knowledge_base_id="kb", **data)],
            [edge("t", "k")],
        )
    )
    runner = Runner(
        plan, run_id="r", input="Remember this", sink=events.append, knowledge=knowledge
    )
    return asyncio.run(runner.run()), events


def test_stores_the_rendered_content_under_its_title() -> None:
    knowledge = FakeKnowledge()
    outcome, events = run(
        {"title": "Notes about {{input}}", "content": "Text: {{input}}"}, knowledge
    )
    assert outcome.status == "succeeded"
    assert knowledge.added == [("kb", "Notes about Remember this.md", "Text: Remember this")]
    finished = next(e for e in events if e["type"] == "node_finished" and e["node_id"] == "k")
    assert finished["output"]["chunk_count"] == 1
    assert any("is searchable (1 chunk)" in e.get("message", "") for e in events)


@pytest.mark.parametrize(
    ("data", "knowledge", "message"),
    [
        # (A blank field is a validation error; this renders empty at run time.)
        ({"content": "{{input.missing}}"}, FakeKnowledge(), "the content is empty"),
        ({}, FakeKnowledge(error="The knowledge base no longer exists"), "no longer exists"),
    ],
)
def test_problems_fail_the_node(data: dict, knowledge: FakeKnowledge, message: str) -> None:
    outcome, events = run(data, knowledge)
    assert outcome.status == "failed"
    finished = next(e for e in events if e["type"] == "node_finished" and e["node_id"] == "k")
    assert message in finished["error"]


# ── For real (emulators) ──────────────────────────────────────────────────


@pytest.fixture
def client(kb_client: TestClient) -> TestClient:
    return kb_client


def run_flow(client: TestClient, nodes: list[dict], edges: list[dict]) -> dict[str, Any]:
    saved = client.post("/flows", json={"name": "KB flow", "nodes": nodes, "edges": edges}).json()
    run_id = client.post(f"/flows/{saved['flow_id']}/runs", json={}).json()["run_id"]
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        info = client.get(f"/runs/{run_id}").json()
        if info["status"] in ("succeeded", "failed", "cancelled"):
            return info
        time.sleep(0.1)
    raise AssertionError(f"run still going: {info}")


@requires_firestore_emulator
@requires_storage_emulator
class TestAddThenRetrieve:
    def test_a_run_stores_text_and_finds_it_again(self, client: TestClient) -> None:
        kb_id = new_kb(client)
        info = run_flow(
            client,
            [
                node("t", "trigger_manual", input="The office wifi password is mesh-2026."),
                node("k", "kb_upload", knowledge_base_id=kb_id, title="Office notes"),
                node("r", "kb_retriever", knowledge_base_id=kb_id, query="wifi password"),
                node("o", "output_display"),
            ],
            [edge("t", "k"), edge("k", "r"), edge("r", "o")],
        )
        assert info["status"] == "succeeded", info
        added = info["node_states"]["k"]["output"]
        assert (added["name"], added["chunk_count"]) == ("Office notes.md", 1)
        found = info["node_states"]["o"]["output"]
        assert found[0]["source"] == "Office notes.md"
        assert "mesh-2026" in found[0]["text"]
        listed = client.get(f"/knowledge-bases/{kb_id}/documents").json()
        assert [(d["name"], d["status"]) for d in listed] == [("Office notes.md", "ready")]

    def test_processing_failures_fail_the_node(self, client: TestClient) -> None:
        keyed = client.post(
            "/knowledge-bases", json={"name": "Keyed", "embedding_model": "text-embedding-3-small"}
        ).json()["knowledge_base_id"]
        info = run_flow(
            client,
            [
                node("t", "trigger_manual", input="Some text"),
                node("k", "kb_upload", knowledge_base_id=keyed, title="X"),
            ],
            [edge("t", "k")],
        )
        assert info["status"] == "failed"
        assert info["node_states"]["k"]["error"].startswith(
            "“X.md” was stored but couldn't be processed: No API key for OpenAI"
        )
