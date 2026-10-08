/**
 * Runs API (see backend/app/api/runs.py) and its live event stream. Event shapes mirror
 * backend/app/engine/events.py.
 */
import type { ApiClient } from "@/lib/api";
import { createSseParser } from "@/lib/sse";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type NodeRunStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export interface NodeRunState {
  status: NodeRunStatus;
  started_at: string | null;
  finished_at: string | null;
  output: unknown;
  output_truncated: boolean;
  error: string | null;
  handles: string[] | null;
}

export interface RunInfo {
  run_id: string;
  flow_id: string;
  flow_version: number;
  status: RunStatus;
  trigger_id: string;
  input: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  node_states: Record<string, NodeRunState>;
}

interface Stamped {
  at: string;
  seq: number;
}

export type RunEvent =
  | (Stamped & { type: "run_started"; run_id: string; trigger_id: string })
  | (Stamped & { type: "node_started"; node_id: string })
  | (Stamped & { type: "token"; node_id: string; text: string })
  | (Stamped & {
      type: "log";
      node_id?: string;
      level: "info" | "warning" | "error";
      message: string;
    })
  | (Stamped & {
      type: "node_finished";
      node_id: string;
      status: Exclude<NodeRunStatus, "pending" | "running">;
      output?: unknown;
      handles?: string[];
      error?: string;
    })
  | (Stamped & { type: "run_finished"; status: Exclude<RunStatus, "queued" | "running">; error?: string })
  /** Sent instead of events when the run is no longer live on the server. */
  | { type: "snapshot"; run: RunInfo };

export interface RunRequest {
  trigger_id?: string;
  input?: string;
}

export function runsApi(api: ApiClient) {
  const path = (id: string) => `/runs/${encodeURIComponent(id)}`;
  return {
    start: (flowId: string, body: RunRequest = {}) =>
      api.post<RunInfo>(`/flows/${encodeURIComponent(flowId)}/runs`, body),
    get: (runId: string) => api.get<RunInfo>(path(runId)),
    cancel: (runId: string) => api.post<RunInfo>(`${path(runId)}/cancel`),
    /** One connection to the run's event stream; resolves when the server ends it. */
    async stream(
      runId: string,
      onEvent: (event: RunEvent) => void,
      { after = 0, signal }: { after?: number; signal?: AbortSignal } = {},
    ): Promise<void> {
      const response = await api.fetch(`${path(runId)}/stream`, {
        headers: after > 0 ? { "Last-Event-ID": String(after) } : {},
        signal,
      });
      if (!response.body) throw new Error("This browser can't read streamed responses.");
      const parser = createSseParser((message) => onEvent(JSON.parse(message.data) as RunEvent));
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        parser.feed(value);
      }
    },
  };
}

const isFinished = (event: RunEvent) => event.type === "run_finished" || event.type === "snapshot";

/**
 * Follows a run until it finishes, reconnecting (with Last-Event-ID, so nothing is lost or
 * repeated) when the connection drops. Gives up after `attempts` failed connections in a row.
 */
export async function followRun(
  api: ReturnType<typeof runsApi>,
  runId: string,
  onEvent: (event: RunEvent) => void,
  { signal, attempts = 5 }: { signal?: AbortSignal; attempts?: number } = {},
): Promise<void> {
  let lastSeq = 0;
  let failures = 0;
  let finished = false;
  const handle = (event: RunEvent) => {
    if ("seq" in event) {
      if (event.seq <= lastSeq) return;
      lastSeq = event.seq;
    }
    failures = 0;
    if (isFinished(event)) finished = true;
    onEvent(event);
  };
  while (!finished && !signal?.aborted) {
    let failure: unknown = null;
    try {
      await api.stream(runId, handle, { after: lastSeq, signal });
    } catch (error) {
      failure = error;
    }
    if (finished || signal?.aborted) return;
    // Ended (or broke) before the run finished. Events reset `failures`, so only connections in
    // a row that get nothing count towards giving up.
    if (++failures >= attempts) throw failure ?? new Error("Lost the connection to the run.");
    await sleep(Math.min(500 * 2 ** failures, 5000), signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
