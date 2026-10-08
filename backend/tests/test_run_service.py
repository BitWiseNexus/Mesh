"""Live-run plumbing without Firestore: event log, recorder, manager."""

import asyncio
import json
from typing import Any

from app.core.config import Settings
from app.engine import events
from app.engine.compiler import compile_flow
from app.repositories.runs import OUTPUT_MAX_CHARS, RunRecorder
from app.services.runs import RunEventLog, RunManager
from tests.flows import edge, flow, node


class FakeRepository:
    def __init__(self, fail_times: int = 0) -> None:
        self.writes: list[dict[str, Any]] = []
        self.fail_times = fail_times

    async def update(self, run_id: str, fields: dict[str, Any]) -> None:
        await asyncio.sleep(0)
        if self.fail_times:
            self.fail_times -= 1
            raise RuntimeError("Firestore unavailable")
        self.writes.append(fields)

    def merged(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for w in self.writes:
            result |= w
        return result


def test_event_log_replays_and_follows() -> None:
    async def main() -> tuple[list, list]:
        log = RunEventLog()
        log.publish({"type": "a"})
        late: list = []

        async def reader(after: int, into: list) -> None:
            async for e in log.follow(after, keepalive=10):
                into.append(e and e["seq"])

        early: list = []
        tasks = [asyncio.create_task(reader(0, early)), asyncio.create_task(reader(1, late))]
        await asyncio.sleep(0.01)
        log.publish({"type": "b"})
        log.publish({"type": "c"})
        log.close()
        await asyncio.gather(*tasks)
        return early, late

    early, late = asyncio.run(main())
    assert early == [1, 2, 3]
    assert late == [2, 3]  # resumed after seq 1


def test_event_log_sends_keepalives_while_idle() -> None:
    async def main() -> list:
        log = RunEventLog()
        seen: list = []

        async def reader() -> None:
            async for e in log.follow(keepalive=0.02):
                seen.append(e)
                if e is None:
                    log.close()

        await asyncio.wait_for(reader(), 1)
        return seen

    assert asyncio.run(main()) == [None]


def _recorded(event_list: list[dict], repository: FakeRepository | None = None) -> FakeRepository:
    repository = repository or FakeRepository()

    async def main() -> None:
        recorder = RunRecorder(repository, "r1")  # type: ignore[arg-type]
        for e in event_list:
            recorder.record(e)
        await recorder.close()

    asyncio.run(main())
    return repository


def test_recorder_persists_transitions_not_tokens() -> None:
    repository = _recorded(
        [
            events.run_started("r1", "t"),
            events.node_started("t"),
            events.token("t", "ignored"),
            events.log("ignored"),
            events.node_finished("t", "succeeded", output={"a": [[1]]}, handles=["out"]),
            events.node_started("bad"),
            events.node_finished("bad", "failed", error="boom"),
            events.run_finished("failed", "“Bad” failed: boom"),
        ]
    )
    final = repository.merged()
    assert final["status"] == "failed" and final["error"] == "“Bad” failed: boom"
    assert final["started_at"] and final["finished_at"]
    t = final["node_states.t"]
    assert t["status"] == "succeeded" and t["handles"] == ["out"]
    assert t["started_at"] <= t["finished_at"]
    assert json.loads(t["output_json"]) == {"a": [[1]]} and t["output_truncated"] is False
    assert final["node_states.bad"] | {"started_at": None, "finished_at": None} == {
        "status": "failed",
        "error": "boom",
        "started_at": None,
        "finished_at": None,
    }
    assert not any("ignored" in json.dumps(w, default=str) for w in repository.writes)
    # Events recorded before the writer ran are merged into one write.
    assert len(repository.writes) == 1


def test_recorder_quotes_node_ids_in_field_paths() -> None:
    repository = _recorded([events.node_started("node.with-dash")])
    assert list(repository.merged()) == ["node_states.`node.with-dash`"]


def test_recorder_caps_outputs() -> None:
    long_text = "x" * (OUTPUT_MAX_CHARS + 10)
    repository = _recorded([events.node_finished("t", "succeeded", output=long_text)])
    state = repository.merged()["node_states.t"]
    assert state["output_truncated"] is True and state["output_json"] == "x" * OUTPUT_MAX_CHARS


def test_recorder_retries_failed_writes() -> None:
    repository = _recorded([events.run_started("r1", "t")], FakeRepository(fail_times=2))
    assert repository.merged()["status"] == "running"


def test_manager_runs_flows_and_cancels_them() -> None:
    long_task = " ".join(["word"] * 200)  # mock/echo streams one word per 30 ms
    plan = compile_flow(
        flow(
            [node("t", "trigger_manual"), node("a", "agent_node", model="mock/echo")],
            [edge("t", "a")],
        )
    )

    async def main() -> tuple[list[str], dict, int]:
        manager = RunManager(Settings(run_events_retention_seconds=60))
        repository = FakeRepository()
        live = manager.start(
            run_id="r1", owner_uid="u", plan=plan, input=long_task, repository=repository
        )
        assert manager.active_runs("u") == 1 and manager.active_runs("other") == 0
        async for e in live.log.follow():  # wait until the agent is streaming
            if e and e["type"] == "token":
                break
        await manager.cancel("r1")
        active = manager.active_runs("u")
        return [e["type"] for e in live.log.events], repository.merged(), active

    types, record, active = asyncio.run(main())
    assert types[0] == "run_started" and types[-1] == "run_finished"
    assert record["status"] == "cancelled"
    assert record["node_states.a"]["status"] == "cancelled"
    assert active == 0
