/**
 * The editor's current run: live node statuses, streamed text, outputs and a log, built from the
 * run's event stream (`applyRunEvent`, pure). Separate from the flow store: runs aren't content
 * (no undo, no autosave) and token updates must not touch the graph.
 */
import { create } from "zustand";

import type { NodeRunStatus, RunEvent, RunInfo, RunStatus } from "@/lib/runs-api";

export interface NodeRun {
  status: NodeRunStatus;
  /** Text streamed so far (agents). */
  text: string;
  output?: unknown;
  outputTruncated?: boolean;
  error?: string;
  /** Output handles that delivered (others were skipped). */
  handles?: string[];
  startedAt?: string;
  finishedAt?: string;
}

export interface RunLogEntry {
  at: string;
  level: "info" | "warning" | "error";
  nodeId?: string;
  message: string;
}

export type RunPhase = "idle" | "starting" | RunStatus;

export interface RunState {
  /** Flow the run belongs to (a run is cleared when another flow opens). */
  flowId: string | null;
  runId: string | null;
  phase: RunPhase;
  error: string | null;
  nodes: Record<string, NodeRun>;
  /** Node ids in the order they started. */
  order: string[];
  log: RunLogEntry[];
  startedAt: string | null;
  finishedAt: string | null;
  panelOpen: boolean;
}

export const IDLE_RUN: RunState = {
  flowId: null,
  runId: null,
  phase: "idle",
  error: null,
  nodes: {},
  order: [],
  log: [],
  startedAt: null,
  finishedAt: null,
  panelOpen: false,
};

export const isRunActive = (phase: RunPhase) =>
  phase === "starting" || phase === "queued" || phase === "running";

const FINISHED_LABEL: Record<string, string> = {
  succeeded: "finished",
  failed: "failed",
  skipped: "skipped (its branch wasn't taken)",
  cancelled: "stopped",
};

/** The state after `event`. Pure, so it's easy to test and cheap to replay. */
export function applyRunEvent(state: RunState, event: RunEvent): RunState {
  const node = (id: string): NodeRun => state.nodes[id] ?? { status: "pending", text: "" };
  const withNode = (id: string, patch: Partial<NodeRun>, entry?: RunLogEntry): RunState => ({
    ...state,
    nodes: { ...state.nodes, [id]: { ...node(id), ...patch } },
    order: state.order.includes(id) ? state.order : [...state.order, id],
    log: entry ? [...state.log, entry] : state.log,
  });

  switch (event.type) {
    case "run_started":
      return {
        ...state,
        phase: "running",
        startedAt: event.at,
        log: [...state.log, { at: event.at, level: "info", message: "Run started" }],
      };
    case "node_started":
      return withNode(
        event.node_id,
        { status: "running", startedAt: event.at, text: "" },
        { at: event.at, level: "info", nodeId: event.node_id, message: "started" },
      );
    case "token":
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [event.node_id]: { ...node(event.node_id), text: node(event.node_id).text + event.text },
        },
      };
    case "log":
      return {
        ...state,
        log: [
          ...state.log,
          { at: event.at, level: event.level, nodeId: event.node_id, message: event.message },
        ],
      };
    case "node_finished":
      return withNode(
        event.node_id,
        {
          status: event.status,
          finishedAt: event.at,
          ...(event.status === "succeeded" ? { output: event.output, handles: event.handles } : {}),
          ...(event.error ? { error: event.error } : {}),
        },
        {
          at: event.at,
          level: event.status === "failed" ? "error" : "info",
          nodeId: event.node_id,
          message: event.error
            ? `${FINISHED_LABEL.failed}: ${event.error}`
            : FINISHED_LABEL[event.status],
        },
      );
    case "run_finished":
      return {
        ...state,
        phase: event.status,
        error: event.error ?? null,
        finishedAt: event.at,
        log: [
          ...state.log,
          {
            at: event.at,
            level: event.status === "failed" ? "error" : "info",
            message:
              event.status === "succeeded"
                ? "Run finished"
                : event.status === "cancelled"
                  ? "Run stopped"
                  : (event.error ?? "Run failed"),
          },
        ],
      };
    case "snapshot":
      return fromRunInfo(state, event.run);
  }
}

/** The state of a run from its stored record (when the live stream is no longer available). */
export function fromRunInfo(state: RunState, run: RunInfo): RunState {
  const ids = Object.keys(run.node_states).sort((a, b) =>
    (run.node_states[a].started_at ?? "").localeCompare(run.node_states[b].started_at ?? ""),
  );
  const nodes: Record<string, NodeRun> = {};
  for (const id of ids) {
    const s = run.node_states[id];
    nodes[id] = {
      status: s.status,
      // Streamed text isn't stored; a finished agent's reply is its output.
      text: s.status === "succeeded" && typeof s.output === "string" ? s.output : "",
      output: s.output,
      outputTruncated: s.output_truncated,
      error: s.error ?? undefined,
      handles: s.handles ?? undefined,
      startedAt: s.started_at ?? undefined,
      finishedAt: s.finished_at ?? undefined,
    };
  }
  return {
    ...state,
    runId: run.run_id,
    phase: run.status,
    error: run.error,
    nodes,
    order: ids,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
  };
}

interface RunStore extends RunState {
  /** Starts tracking a run of `flowId` (the panel opens). */
  begin: (flowId: string) => void;
  attach: (run: RunInfo) => void;
  apply: (event: RunEvent) => void;
  /** The run couldn't start or the stream was lost: finish with an error (+ details for the log). */
  fail: (message: string, details?: string[]) => void;
  setPanelOpen: (open: boolean) => void;
  reset: () => void;
}

export const useRunStore = create<RunStore>()((set, get) => ({
  ...IDLE_RUN,
  begin: (flowId) => set({ ...IDLE_RUN, flowId, phase: "starting", panelOpen: true }),
  attach: (run) => set({ runId: run.run_id, phase: run.status }),
  apply: (event) => set(applyRunEvent(get(), event)),
  fail: (message, details = []) => {
    const at = new Date().toISOString();
    set({
      phase: "failed",
      error: message,
      log: [...get().log, ...[message, ...details].map((m) => ({ at, level: "error" as const, message: m }))],
    });
  },
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  reset: () => set(IDLE_RUN),
}));

/** How a data edge looks during/after a run: carrying data right now, delivered, or skipped. */
export type EdgeRunState = "active" | "delivered" | "skipped" | null;

export function edgeRunState(
  nodes: Record<string, NodeRun>,
  edge: { source: string; target: string; sourceHandle?: string | null },
): EdgeRunState {
  const source = nodes[edge.source];
  if (!source) return null;
  if (source.status === "skipped") return "skipped";
  if (source.status !== "succeeded") return null;
  const handle = edge.sourceHandle ?? "out";
  if (source.handles && !source.handles.includes(handle)) return "skipped";
  return nodes[edge.target]?.status === "running" ? "active" : "delivered";
}
