import { beforeEach, describe, expect, it } from "vitest";

import type { RunEvent, RunInfo } from "@/lib/runs-api";

import {
  applyRunEvent,
  edgeRunState,
  fromRunInfo,
  IDLE_RUN,
  isRunActive,
  toolEdgeRunState,
  useRunStore,
  type RunState,
} from "./run-store";

const at = "2026-01-01T00:00:00.000Z";
let seq = 0;
const e = (event: Record<string, unknown>) => ({ at, seq: ++seq, ...event }) as RunEvent;

const replay = (...events: RunEvent[]): RunState =>
  events.reduce(applyRunEvent, { ...IDLE_RUN, phase: "queued" } as RunState);

describe("applyRunEvent", () => {
  it("builds node statuses, streamed text, outputs and a log", () => {
    const state = replay(
      e({ type: "run_started", run_id: "r", trigger_id: "t" }),
      e({ type: "node_started", node_id: "t" }),
      e({ type: "node_finished", node_id: "t", status: "succeeded", output: "hi", handles: ["out"] }),
      e({ type: "node_started", node_id: "a" }),
      e({ type: "token", node_id: "a", text: "Hel" }),
      e({ type: "token", node_id: "a", text: "lo" }),
      e({ type: "log", node_id: "a", level: "warning", message: "{{x.output}} has no value" }),
    );
    expect(state.phase).toBe("running");
    expect(state.order).toEqual(["t", "a"]);
    expect(state.nodes.t).toMatchObject({ status: "succeeded", output: "hi", handles: ["out"] });
    expect(state.nodes.a).toMatchObject({ status: "running", text: "Hello" });
    expect(state.log.map((l) => [l.level, l.nodeId, l.message])).toEqual([
      ["info", undefined, "Run started"],
      ["info", "t", "started"],
      ["info", "t", "finished"],
      ["info", "a", "started"],
      ["warning", "a", "{{x.output}} has no value"],
    ]);
  });

  it("records failures and the run's outcome", () => {
    const state = replay(
      e({ type: "run_started", run_id: "r", trigger_id: "t" }),
      e({ type: "node_started", node_id: "a" }),
      e({ type: "node_finished", node_id: "a", status: "failed", error: "No API key" }),
      e({ type: "run_finished", status: "failed", error: "“Agent” failed: No API key" }),
    );
    expect(state.phase).toBe("failed");
    expect(state.error).toBe("“Agent” failed: No API key");
    expect(state.nodes.a).toMatchObject({ status: "failed", error: "No API key" });
    expect(state.log.at(-2)).toMatchObject({ level: "error", message: "failed: No API key" });
    expect(state.finishedAt).toBe(at);
    expect(isRunActive(state.phase)).toBe(false);
  });

  it("replaces everything with a snapshot", () => {
    const run: RunInfo = {
      run_id: "r",
      flow_id: "f",
      flow_version: 2,
      status: "succeeded",
      trigger_id: "t",
      input: null,
      error: null,
      created_at: at,
      started_at: at,
      finished_at: "2026-01-01T00:00:02.000Z",
      node_states: {
        a: {
          status: "succeeded",
          started_at: "2026-01-01T00:00:01.000Z",
          finished_at: at,
          output: "reply",
          output_truncated: false,
          error: null,
          handles: ["out"],
        },
        t: {
          status: "succeeded",
          started_at: at,
          finished_at: at,
          output: { x: 1 },
          output_truncated: false,
          error: null,
          handles: ["out"],
        },
      },
    };
    const before = replay(e({ type: "node_started", node_id: "zzz" }));
    const state = applyRunEvent(before, { type: "snapshot", run });
    expect(state).toEqual(fromRunInfo(before, run));
    expect(state.order).toEqual(["t", "a"]); // by start time
    expect(state.nodes.a.text).toBe("reply");
    expect(state.nodes.zzz).toBeUndefined();
    expect(state.phase).toBe("succeeded");
  });
});

describe("tool calls", () => {
  const call = (id: string, tool: string) =>
    e({ type: "tool_call", node_id: "a", tool_node_id: tool, call_id: id, name: `fn_${tool}`, arguments: { q: "x" } });

  it("track calls on the agent and the tool node's latest status", () => {
    const running = replay(e({ type: "node_started", node_id: "a" }), call("c1", "s"));
    expect(running.nodes.s).toMatchObject({ status: "running", calls: 1 });
    expect(running.nodes.a.toolCalls).toEqual([
      { callId: "c1", toolNodeId: "s", name: "fn_s", arguments: { q: "x" }, status: "running" },
    ]);
    expect(running.order).toEqual(["a", "s"]);
    expect(toolEdgeRunState(running.nodes, { target: "s" })).toBe("active");

    const done = [
      e({ type: "tool_result", node_id: "a", tool_node_id: "s", call_id: "c1", status: "failed", error: "down" }),
      call("c2", "s"),
      e({ type: "tool_result", node_id: "a", tool_node_id: "s", call_id: "c2", status: "succeeded", output: [1] }),
    ].reduce(applyRunEvent, running);
    expect(done.nodes.s).toMatchObject({ status: "succeeded", calls: 2, output: [1], error: undefined });
    expect(done.nodes.a.toolCalls?.map((c) => [c.status, c.error ?? c.output])).toEqual([
      ["failed", "down"],
      ["succeeded", [1]],
    ]);
    expect(done.log.map((l) => [l.level, l.message]).slice(-3)).toEqual([
      ["warning", "fn_s failed: down"],
      ["info", "calls fn_s"],
      ["info", "fn_s returned"],
    ]);
    expect(toolEdgeRunState(done.nodes, { target: "s" })).toBe("delivered");
    expect(toolEdgeRunState(done.nodes, { target: "never_called" })).toBeNull();
  });

  it("a call to a tool that doesn't exist only shows on the agent", () => {
    const state = replay(call("c1", ""));
    expect(Object.keys(state.nodes)).toEqual(["a"]);
  });
});

describe("edgeRunState", () => {
  const { nodes } = replay(
    e({ type: "node_finished", node_id: "if", status: "succeeded", output: 1, handles: ["true"] }),
    e({ type: "node_started", node_id: "yes" }),
    e({ type: "node_finished", node_id: "skip", status: "skipped" }),
  );

  it.each([
    [{ source: "if", target: "yes", sourceHandle: "true" }, "active"],
    [{ source: "if", target: "no", sourceHandle: "false" }, "skipped"],
    [{ source: "if", target: "done", sourceHandle: "true" }, "delivered"],
    [{ source: "skip", target: "x" }, "skipped"],
    [{ source: "yes", target: "x" }, null],
    [{ source: "unknown", target: "x" }, null],
  ])("%o → %s", (edge, expected) => {
    expect(edgeRunState(nodes, edge)).toBe(expected);
  });
});

describe("loops", () => {
  it("records which pass a node is on", () => {
    const state = replay(
      e({ type: "node_started", node_id: "a", iteration: 1 }),
      e({ type: "node_finished", node_id: "a", status: "succeeded", output: "x!", handles: ["out"] }),
      e({ type: "node_started", node_id: "a", iteration: 2 }),
    );
    expect(state.nodes.a).toMatchObject({ status: "running", iteration: 2, text: "" });
    expect(state.order).toEqual(["a"]);
  });
});

describe("useRunStore", () => {
  beforeEach(() => useRunStore.getState().reset());

  it("shows a past run from the history", () => {
    const run: RunInfo = {
      run_id: "old",
      flow_id: "f1",
      flow_version: 3,
      status: "succeeded",
      trigger_id: "t",
      input: null,
      error: null,
      created_at: at,
      started_at: at,
      finished_at: at,
      node_states: {
        a: {
          status: "succeeded",
          started_at: at,
          finished_at: at,
          output: "done",
          output_truncated: false,
          error: null,
          handles: ["out"],
          iteration: 4,
        },
      },
    };
    useRunStore.getState().showRun("f1", run);
    expect(useRunStore.getState()).toMatchObject({
      flowId: "f1",
      runId: "old",
      phase: "succeeded",
      fromHistory: true,
      panelOpen: true,
      createdAt: at,
      flowVersion: 3,
    });
    expect(useRunStore.getState().nodes.a).toMatchObject({ output: "done", iteration: 4 });
    // Starting a new run is a live one again.
    useRunStore.getState().begin("f1");
    expect(useRunStore.getState()).toMatchObject({ fromHistory: false, nodes: {}, flowVersion: null });
  });

  it("remembers when a started run was created, and from which version", () => {
    useRunStore.getState().begin("f1");
    useRunStore.getState().attach({ run_id: "r", status: "queued", created_at: at, flow_version: 7 } as RunInfo);
    expect(useRunStore.getState()).toMatchObject({ runId: "r", createdAt: at, flowVersion: 7 });
  });

  it("begins a run with the panel open and fails with details in the log", () => {
    const store = useRunStore.getState();
    store.begin("f1");
    expect(useRunStore.getState()).toMatchObject({ flowId: "f1", phase: "starting", panelOpen: true });
    store.fail("Some nodes can't run yet.", ["“If / Else”: can't run yet"]);
    const state = useRunStore.getState();
    expect(state.phase).toBe("failed");
    expect(state.error).toBe("Some nodes can't run yet.");
    expect(state.log.map((l) => l.message)).toEqual([
      "Some nodes can't run yet.",
      "“If / Else”: can't run yet",
    ]);
  });
});
