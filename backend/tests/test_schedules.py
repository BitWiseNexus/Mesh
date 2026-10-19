"""Schedule triggers: deciding schedules from a flow, the executor, keeping `schedules` in step
with saved flows and firing them (app/services/schedules.py) — the latter against the Firestore
emulator, with the scheduler's clock in the tests' hands."""

import asyncio
import time
import urllib.request
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.auth import AuthUser, get_current_user
from app.core.config import Settings
from app.core.firebase import get_db
from app.engine.compiler import compile_flow
from app.engine.runner import Runner
from app.main import app
from app.repositories.schedules import ScheduleRepository, schedule_id
from app.schemas.flows_api import StoredFlow
from app.services.cron import load_timezone
from app.services.schedules import FLOW_PROBLEMS, Scheduler, paused, wanted_schedules
from tests.conftest import FIRESTORE_EMULATOR, requires_firestore_emulator
from tests.flows import edge, flow, node

NOW = datetime(2026, 10, 17, 10, 7, 30, tzinfo=UTC)


def stored(nodes: list[dict], edges: list[dict] | None = None) -> StoredFlow:
    plain = flow(nodes, edges or [])
    return StoredFlow(**plain.model_dump(), created_at=NOW, updated_at=NOW, version=1)


# ── Deciding schedules ────────────────────────────────────────────────────


def test_each_schedule_trigger_gets_a_schedule() -> None:
    wanted = wanted_schedules(
        "alice",
        stored(
            [
                node("a", "trigger_cron", cron="*/15 * * * *", timezone="Asia/Kolkata"),
                node("b", "trigger_cron"),  # defaults: 9:00 daily, UTC, on
                node("c", "trigger_cron", enabled=False),
                node("m", "trigger_manual"),
            ]
        ),
        NOW,
    )
    assert [(w["node_id"], w["next_run_at"], w["problem"], w["enabled"]) for w in wanted] == [
        ("a", datetime(2026, 10, 17, 10, 15, tzinfo=UTC), None, True),
        ("b", datetime(2026, 10, 18, 9, tzinfo=UTC), None, True),
        ("c", None, None, False),
    ]
    assert wanted[0] == {
        "owner_uid": "alice",
        "flow_id": "f1",
        "node_id": "a",
        "cron": "*/15 * * * *",
        "timezone": "Asia/Kolkata",
        "enabled": True,
        "problem": None,
        "next_run_at": datetime(2026, 10, 17, 10, 15, tzinfo=UTC),
    }


@pytest.mark.parametrize(
    ("data", "extra", "problem"),
    [
        ({"cron": "61 * * * *"}, [], "The cron expression has an invalid minute: “61”."),
        (
            {"timezone": "Mars/Olympus"},
            [],
            "“Mars/Olympus” isn't a timezone (e.g. UTC or Europe/Berlin).",
        ),
        ({}, [node("a", "agent_node", model="")], FLOW_PROBLEMS),
    ],
)
def test_problems_keep_it_unscheduled(data: dict, extra: list, problem: str) -> None:
    edges = [edge("s", "a")] if extra else []
    [wanted] = wanted_schedules(
        "alice", stored([node("s", "trigger_cron", **data), *extra], edges), NOW
    )
    assert (wanted["next_run_at"], wanted["problem"]) == (None, problem)


def test_copies_start_switched_off() -> None:
    nodes = stored([node("s", "trigger_cron", cron="0 * * * *"), node("m", "trigger_manual")]).nodes
    copy = paused(nodes)
    assert (copy[0].data["cron"], copy[0].data["enabled"]) == ("0 * * * *", False)
    assert copy[1] == nodes[1]
    assert nodes[0].data.get("enabled") is None  # the original is untouched


def test_timezones_are_suggested_by_the_server() -> None:
    zones = TestClient(app).get("/timezones").json()
    assert zones[0] == "UTC"
    assert {"Asia/Kolkata", "Asia/Calcutta", "Europe/Berlin", "America/New_York"} <= set(zones)
    assert zones[1:] == sorted(zones[1:])
    assert not any(z.startswith("Etc/") or "/" not in z for z in zones[1:])
    assert all(load_timezone(z) is not None for z in zones)


# ── The executor ──────────────────────────────────────────────────────────


def run_trigger(input: Any, **data: Any) -> tuple[Any, list[str]]:
    events: list[dict] = []
    plan = compile_flow(flow([node("s", "trigger_cron", **data)], []))
    outcome = asyncio.run(Runner(plan, run_id="r", input=input, sink=events.append).run())
    assert outcome.status == "succeeded"
    finished = next(e for e in events if e["type"] == "node_finished")
    return finished["output"], [e["message"] for e in events if e["type"] == "log"]


def test_outputs_when_the_run_was_due() -> None:
    due = {"scheduled_at": "2026-10-17T09:00:00+02:00", "timezone": "Europe/Berlin"}
    assert run_trigger(due) == (due, [])


def test_runs_started_by_hand_use_the_current_time() -> None:
    before = datetime.now(UTC).replace(microsecond=0)
    output, logs = run_trigger(None, timezone="Asia/Kolkata")
    assert output["timezone"] == "Asia/Kolkata"
    at = datetime.fromisoformat(output["scheduled_at"])
    assert at.utcoffset() == timedelta(hours=5, minutes=30)
    assert before <= at <= datetime.now(UTC)
    assert logs == ["Started by hand, not by the schedule: using the current time"]


# ── The scheduler loop ────────────────────────────────────────────────────


def test_the_loop_wakes_every_minute_and_survives_failures() -> None:
    naps: list[float] = []
    ticks = 0

    async def nap(seconds: float) -> None:
        naps.append(seconds)
        if len(naps) == 2:
            raise asyncio.CancelledError

    async def tick(now: datetime | None = None) -> list[str]:
        nonlocal ticks
        ticks += 1
        if ticks == 1:
            raise RuntimeError("database unreachable")
        return []

    scheduler = Scheduler(Settings(), None, None, clock=lambda: NOW, sleep=nap)  # type: ignore[arg-type]
    scheduler.tick = tick  # type: ignore[method-assign]
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(scheduler._loop())
    assert ticks == 2
    assert naps == [30.5, 30.5]  # 10:07:30 → half a second after 10:08:00


# ── Saved flows and firing (Firestore emulator) ──────────────────────────

CLEAR_URL = f"{FIRESTORE_EMULATOR}/emulator/v1/projects/demo-mesh/databases/(default)/documents"

DAILY = {
    "name": "Morning report",
    "nodes": [
        node("s", "trigger_cron", "schedule", cron="*/5 * * * *", timezone="Europe/Berlin"),
        node(
            "a",
            "agent_node",
            model="mock/echo",
            prompt="Report for {{schedule.output.scheduled_at}}",
        ),
        node("out", "output_display", "result"),
    ],
    "edges": [edge("s", "a"), edge("a", "out")],
}


@pytest.fixture
def client() -> Iterator[TestClient]:
    urllib.request.urlopen(urllib.request.Request(CLEAR_URL, method="DELETE"), timeout=5)
    get_db.cache_clear()
    with TestClient(app) as test_client:
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="alice")
        yield test_client
    app.dependency_overrides.clear()
    get_db.cache_clear()


def call(client: TestClient, fn: Any, *args: Any) -> Any:
    """Runs a coroutine function on the app's event loop (where its Firestore client lives)."""
    return client.portal.call(fn, *args)  # type: ignore[union-attr]


def create(client: TestClient, flow: dict[str, Any] = DAILY) -> dict[str, Any]:
    response = client.post("/flows", json=flow)
    assert response.status_code == 201, response.text
    return response.json()


def schedules(client: TestClient, flow_id: str) -> list[dict[str, Any]]:
    response = client.get(f"/flows/{flow_id}/schedules")
    assert response.status_code == 200, response.text
    return response.json()


def stored_schedule(client: TestClient, flow_id: str, node_id: str = "s") -> Any:
    async def read() -> Any:
        return next(
            (
                s
                for s in await ScheduleRepository(get_db()).list_for_flow("alice", flow_id)
                if s.node_id == node_id
            ),
            None,
        )

    return call(client, read)


def finished(client: TestClient, run_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        run = client.get(f"/runs/{run_id}").json()
        if run["status"] in ("succeeded", "failed", "cancelled"):
            return run
        time.sleep(0.05)
    raise AssertionError(f"run still going: {run}")


def tick(client: TestClient, now: datetime) -> list[str]:
    return call(client, client.app.state.scheduler.tick, now)  # type: ignore[attr-defined]


@requires_firestore_emulator
class TestSavedFlows:
    def test_saving_schedules_it(self, client: TestClient) -> None:
        saved = create(client)
        [info] = schedules(client, saved["flow_id"])
        assert (info["node_id"], info["cron"], info["timezone"], info["enabled"]) == (
            "s",
            "*/5 * * * *",
            "Europe/Berlin",
            True,
        )
        assert info["problem"] is None and info["last_fired_at"] is None
        times = [datetime.fromisoformat(t) for t in info["next_runs"]]
        assert len(times) == 3
        assert times[1] - times[0] == times[2] - times[1] == timedelta(minutes=5)
        assert times[0].minute % 5 == 0 and times[0] > datetime.now(UTC)
        assert all(t.utcoffset() == timedelta(0) for t in times)

    def test_saves_change_and_remove_schedules(self, client: TestClient) -> None:
        saved = create(client)
        flow_id = saved["flow_id"]
        off = {
            **DAILY,
            "nodes": [node("s", "trigger_cron", "schedule", enabled=False), *DAILY["nodes"][1:]],
        }
        response = client.put(f"/flows/{flow_id}", json={**off, "expected_version": 1})
        assert response.status_code == 200, response.text
        [info] = schedules(client, flow_id)
        assert (info["enabled"], info["next_runs"], info["problem"]) == (False, [], None)

        broken = {
            "name": "Broken",
            "nodes": [DAILY["nodes"][0], node("a", "agent_node", model="")],
            "edges": [edge("s", "a")],
        }
        assert client.put(f"/flows/{flow_id}", json=broken).status_code == 200
        assert schedules(client, flow_id)[0]["problem"] == FLOW_PROBLEMS

        empty = {"name": "No schedule", "nodes": [], "edges": []}
        assert client.put(f"/flows/{flow_id}", json=empty).status_code == 200
        assert schedules(client, flow_id) == []

        create_again = create(client)["flow_id"]
        assert client.delete(f"/flows/{create_again}").status_code == 204
        assert stored_schedule(client, create_again) is None

    def test_unchanged_saves_keep_the_next_time(self, client: TestClient) -> None:
        flow_id = create(client)["flow_id"]
        pinned = datetime(2026, 10, 17, 9, 0, tzinfo=UTC)

        async def pin() -> None:
            ref = get_db().collection("schedules").document(schedule_id(flow_id, "s"))
            await ref.update({"next_run_at": pinned})

        call(client, pin)
        assert client.put(f"/flows/{flow_id}", json={**DAILY, "name": "Renamed"}).status_code == 200
        assert stored_schedule(client, flow_id).next_run_at == pinned

    def test_copies_are_switched_off(self, client: TestClient) -> None:
        flow_id = create(client)["flow_id"]
        copy = client.post(f"/flows/{flow_id}/duplicate").json()
        assert next(n for n in copy["nodes"] if n["id"] == "s")["data"]["enabled"] is False
        [info] = schedules(client, copy["flow_id"])
        assert (info["enabled"], info["next_runs"]) == (False, [])
        assert schedules(client, flow_id)[0]["enabled"] is True  # the original runs on

    def test_schedules_are_private(self, client: TestClient) -> None:
        flow_id = create(client)["flow_id"]
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="bob")
        assert client.get(f"/flows/{flow_id}/schedules").status_code == 404


@requires_firestore_emulator
class TestFiring:
    def test_due_schedules_start_runs(self, client: TestClient) -> None:
        flow_id = create(client)["flow_id"]
        due = stored_schedule(client, flow_id).next_run_at
        assert tick(client, due - timedelta(seconds=1)) == []  # not yet

        [run_id] = tick(client, due + timedelta(seconds=1))
        run = finished(client, run_id)
        assert run["status"] == "succeeded", run
        assert run["trigger_id"] == "s"
        when = datetime.fromisoformat(run["node_states"]["s"]["output"]["scheduled_at"])
        assert when == due and when.utcoffset() in (timedelta(hours=1), timedelta(hours=2))
        assert run["node_states"]["out"]["output"] == f"Report for {when.isoformat()}"

        after = stored_schedule(client, flow_id)
        assert after.next_run_at == due + timedelta(minutes=5)
        assert (after.last_fired_at, after.last_run_id, after.last_error) == (due, run_id, None)
        assert tick(client, due + timedelta(seconds=2)) == []  # fired once
        info = schedules(client, flow_id)[0]
        assert info["last_run_id"] == run_id

    def test_a_due_time_fires_once_however_many_check(self, client: TestClient) -> None:
        flow_id = create(client)["flow_id"]
        now = stored_schedule(client, flow_id).next_run_at + timedelta(seconds=1)
        scheduler = client.app.state.scheduler  # type: ignore[attr-defined]

        async def two_at_once() -> list[list[str]]:
            return await asyncio.gather(scheduler.tick(now), scheduler.tick(now))

        assert sorted(len(ids) for ids in call(client, two_at_once)) == [0, 1]

    def test_missed_times_are_skipped_not_caught_up(self, client: TestClient) -> None:
        flow_id = create(client)["flow_id"]
        due = stored_schedule(client, flow_id).next_run_at
        assert tick(client, due + timedelta(minutes=12)) == []
        after = stored_schedule(client, flow_id)
        assert after.next_run_at == due + timedelta(minutes=15)  # the next one after "now"
        assert after.last_error.startswith("Skipped ")
        assert after.last_error.endswith("(Europe/Berlin): the server wasn't running then.")

    def test_runs_that_cant_start_are_reported(self, client: TestClient) -> None:
        flow_id = create(client)["flow_id"]
        due = stored_schedule(client, flow_id).next_run_at
        manager = client.app.state.runs  # type: ignore[attr-defined]
        original = manager.active_runs
        manager.active_runs = lambda uid: 99
        try:
            assert tick(client, due + timedelta(seconds=1)) == []
        finally:
            manager.active_runs = original
        error = stored_schedule(client, flow_id).last_error
        assert error.startswith("Didn't run ") and "too many runs in progress" in error

    def test_schedules_of_removed_triggers_are_dropped(self, client: TestClient) -> None:
        flow_id = create(client)["flow_id"]
        due = datetime(2026, 10, 17, 9, 0, tzinfo=UTC)
        ghost = {
            "owner_uid": "alice",
            "flow_id": flow_id,
            "node_id": "gone",
            "cron": "0 * * * *",
            "timezone": "UTC",
            "enabled": True,
            "problem": None,
            "next_run_at": due,
        }

        async def plant() -> None:
            ref = get_db().collection("schedules").document(schedule_id(flow_id, "gone"))
            await ref.set(ghost)

        call(client, plant)
        assert tick(client, due + timedelta(seconds=1)) == []
        assert stored_schedule(client, flow_id, "gone") is None
