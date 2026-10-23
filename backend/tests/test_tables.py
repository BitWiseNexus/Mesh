"""Tables: the Write to Table node (app/nodes/executors/action_db_write.py), names and limits
(app/schemas/tables.py), and storage + `/tables` against the Firestore emulator."""

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
from app.repositories import tables as tables_repo
from app.schemas.tables import clean_row_id, clean_table_name
from tests.conftest import requires_firestore_emulator
from tests.flows import edge, flow, node

# ── Names ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("name", "result"),
    [
        ("Signups", "Signups"),
        ("  Q3   leads ", "Q3 leads"),
        ("café-orders_2026.v2", "café-orders_2026.v2"),
        ("", "No table: “Table” is empty"),
        ("a/b", "“a/b” can't be a table name"),
        ("x" * 65, "The table name is too long"),
    ],
)
def test_table_names(name: str, result: str) -> None:
    try:
        assert clean_table_name(name) == result
    except ValueError as exc:
        assert str(exc).startswith(result)


@pytest.mark.parametrize(
    ("row_id", "ok"),
    [("ada@example.com", True), (" 42 ", True), ("a/b", False), ("..", False), ("__x", False)],
)
def test_row_ids(row_id: str, ok: bool) -> None:
    if ok:
        assert clean_row_id(row_id) == row_id.strip()
    else:
        with pytest.raises(ValueError):
            clean_row_id(row_id)


# ── The node (fake tables) ────────────────────────────────────────────────


class FakeTables:
    def __init__(self) -> None:
        self.writes: list[dict[str, Any]] = []

    async def write_row(self, table: str, row: dict[str, Any], **kw: Any) -> dict[str, Any]:
        self.writes.append({"table": table, "row": row, **kw})
        return {"table": table, "table_id": "t1", "row_id": "r1", "created": True, "row": row}


def run(data: dict[str, Any], input: Any = 'Ada "the Countess"') -> tuple[str, dict, FakeTables]:
    events: list[dict] = []
    tables = FakeTables()
    plan = compile_flow(
        flow(
            [
                node("t", "trigger_manual", "trigger"),
                node("w", "action_db_write", **{"table": "Signups", **data}),
            ],
            [edge("t", "w")],
        )
    )
    runner = Runner(plan, run_id="run-1", input=input, sink=events.append, tables=tables)
    outcome = asyncio.run(runner.run())
    finished = next(e for e in events if e["type"] == "node_finished" and e["node_id"] == "w")
    return outcome.status, finished, tables


@pytest.mark.parametrize(
    ("row", "input", "stored"),
    [
        # JSON around references: values are escaped into it.
        ('{"name": "{{input}}", "plan": "pro"}', 'Ada "the Countess"', None),
        ("{{input}}", {"name": "Ada", "n": 1}, {"name": "Ada", "n": 1}),
        ("{{input}}", "plain words", {"value": "plain words"}),
        ("{{input}}", '{"from": "an agent"}', {"from": "an agent"}),
        ("{{input}}", "[1, 2]", {"value": "[1, 2]"}),
        ("{{input}}", [1, 2], {"value": [1, 2]}),
        ("Note: {{input}}", "hi", {"value": "Note: hi"}),
    ],
)
def test_rows(row: str, input: Any, stored: dict | None) -> None:
    status, finished, tables = run({"row": row}, input)
    assert status == "succeeded", finished
    expected = stored or {"name": 'Ada "the Countess"', "plan": "pro"}
    assert tables.writes[0]["row"] == expected


def test_the_write_says_where_it_comes_from() -> None:
    status, finished, tables = run({"row_id": "ada@example.com", "merge": True})
    assert status == "succeeded"
    [write] = tables.writes
    assert write | {"row": None} == {
        "table": "Signups",
        "row": None,
        "row_id": "ada@example.com",
        "merge": True,
        "flow_id": "f1",
        "run_id": "run-1",
    }
    assert finished["output"]["row_id"] == "r1"


@pytest.mark.parametrize(
    ("data", "input", "message"),
    [
        ({"row": '{"name": {{input}}}'}, "Ada", "The row isn't valid JSON"),
        ({"row": "{{input.missing}}"}, "x", "Nothing to write: the row is empty"),
    ],
)
def test_problems(data: dict, input: Any, message: str) -> None:
    status, finished, _ = run(data, input)
    assert status == "failed" and finished["error"].startswith(message)


def test_runs_without_tables_refuse() -> None:
    plan = compile_flow(
        flow(
            [node("t", "trigger_manual"), node("w", "action_db_write", table="T")], [edge("t", "w")]
        )
    )
    events: list[dict] = []
    asyncio.run(Runner(plan, run_id="r", input="x", sink=events.append).run())
    finished = next(e for e in events if e["type"] == "node_finished" and e["node_id"] == "w")
    assert finished["error"] == "Tables aren't available in this run"


def test_no_tables_is_a_node_error() -> None:
    from app.engine.context import NoTables

    with pytest.raises(NodeError):
        asyncio.run(NoTables().write_row("T", {}))


# ── Storage and the API (Firestore emulator) ──────────────────────────────


@pytest.fixture
def client(kb_client: TestClient) -> TestClient:
    return kb_client  # signed in as alice, Firestore emptied


def write(client: TestClient, table: str, row: str, input: str = "", **data: Any) -> dict:
    """Runs Trigger → Write to Table and returns the run."""
    nodes = [
        node("t", "trigger_manual", "trigger", input=input),
        node("w", "action_db_write", table=table, row=row, **data),
    ]
    saved = client.post(
        "/flows", json={"name": "Writer", "nodes": nodes, "edges": [edge("t", "w")]}
    )
    run_id = client.post(f"/flows/{saved.json()['flow_id']}/runs", json={}).json()["run_id"]
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        run = client.get(f"/runs/{run_id}").json()
        if run["status"] in ("succeeded", "failed"):
            return run
        time.sleep(0.05)
    raise AssertionError(run)


def rows(client: TestClient, table_id: str) -> list[dict]:
    return client.get(f"/tables/{table_id}/rows").json()


@requires_firestore_emulator
class TestStorage:
    def test_rows_are_added_and_listed(self, client: TestClient) -> None:
        first = write(client, "Signups", '{"name": "{{input}}"}', 'Ada "the Countess"')
        assert first["status"] == "succeeded", first
        written = first["node_states"]["w"]["output"]
        assert (written["table"], written["created"]) == ("Signups", True)
        write(client, "signups", '{"name": "{{input}}"}', "Grace")  # same table, any case

        [table] = client.get("/tables").json()
        assert (table["name"], table["row_count"]) == ("Signups", 2)
        assert table["table_id"] == written["table_id"]
        listed = rows(client, table["table_id"])
        assert [r["data"] for r in listed] == [{"name": "Grace"}, {"name": 'Ada "the Countess"'}]
        assert listed[1]["row_id"] == written["row_id"]
        assert listed[1]["run_id"] == first["run_id"] and listed[1]["flow_id"] == first["flow_id"]

    def test_rows_with_an_id_are_replaced_or_merged(self, client: TestClient) -> None:
        row_id = "ada@example.com"
        write(client, "People", '{"name": "Ada", "plan": "free"}', row_id=row_id)
        write(client, "People", '{"plan": "pro"}', row_id=row_id, merge=True)
        table_id = client.get("/tables").json()[0]["table_id"]
        assert [r["data"] for r in rows(client, table_id)] == [{"name": "Ada", "plan": "pro"}]
        replaced = write(client, "People", '{"plan": "team"}', row_id=row_id)
        assert replaced["node_states"]["w"]["output"]["created"] is False
        assert [r["data"] for r in rows(client, table_id)] == [{"plan": "team"}]
        assert client.get(f"/tables/{table_id}").json()["row_count"] == 1

    def test_deleting_rows_and_tables(self, client: TestClient) -> None:
        write(client, "Log", "{{input}}", "one")
        write(client, "Log", "{{input}}", "two")
        table_id = client.get("/tables").json()[0]["table_id"]
        newest = rows(client, table_id)[0]["row_id"]
        assert client.delete(f"/tables/{table_id}/rows/{newest}").status_code == 204
        assert client.delete(f"/tables/{table_id}/rows/{newest}").status_code == 404
        assert client.get(f"/tables/{table_id}").json()["row_count"] == 1
        assert [r["data"] for r in rows(client, table_id)] == [{"value": "one"}]
        assert client.delete(f"/tables/{table_id}").status_code == 204
        assert client.get("/tables").json() == []
        assert client.get(f"/tables/{table_id}").json()["detail"]["code"] == "table_not_found"
        write(client, "Log", "{{input}}", "again")  # a new table of the same name starts empty
        assert client.get("/tables").json()[0]["row_count"] == 1

    def test_tables_are_private(self, client: TestClient) -> None:
        write(client, "Secrets", "{{input}}", "x")
        table_id = client.get("/tables").json()[0]["table_id"]
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="bob")
        assert client.get("/tables").json() == []
        for response in (
            client.get(f"/tables/{table_id}"),
            client.get(f"/tables/{table_id}/rows"),
            client.delete(f"/tables/{table_id}"),
        ):
            assert response.status_code == 404
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="alice")
        assert client.get(f"/tables/{table_id}").status_code == 200

    def test_limits(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(tables_repo, "MAX_ROWS_PER_TABLE", 1)
        monkeypatch.setattr(tables_repo, "MAX_TABLES_PER_USER", 1)
        monkeypatch.setattr(tables_repo, "MAX_ROW_CHARS", 30)
        assert write(client, "One", "{{input}}", "a")["status"] == "succeeded"
        full = write(client, "One", "{{input}}", "b")
        assert full["node_states"]["w"]["error"].startswith("A table can hold up to")
        other = write(client, "Two", "{{input}}", "c")
        assert other["node_states"]["w"]["error"].startswith("You can have up to")
        big = write(client, "One", "{{input}}", "x" * 40, row_id="r")
        assert big["node_states"]["w"]["error"].startswith("The row is too large")
