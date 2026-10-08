"use client";

import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";

import { useApi } from "@/components/auth/auth-provider";
import { ApiError } from "@/lib/api";
import { followRun, runsApi, type RunInfo } from "@/lib/runs-api";
import { useFlowStore } from "@/stores/flow-store";
import { IDLE_RUN, isRunActive, useRunStore } from "@/stores/run-store";

import { useFlowSave } from "./use-flow-save";

/** The stream currently being followed (one per editor). */
let following: AbortController | null = null;

function stopFollowing() {
  following?.abort();
  following = null;
}

/** Resolves once no save is in flight. */
function saveSettled(): Promise<void> {
  if (useFlowStore.getState().save.status !== "saving") return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useFlowStore.subscribe((s) => {
      if (s.save.status !== "saving") {
        unsubscribe();
        resolve();
      }
    });
  });
}

const issueMessages = (error: ApiError): string[] =>
  Array.isArray(error.details.issues)
    ? error.details.issues.flatMap((i) => (typeof i?.message === "string" ? [i.message] : []))
    : [];

/**
 * Starting, following and stopping runs of the open flow. Runs execute the *saved* flow, so
 * pending edits are saved first. State lives in the run store (see run-store.ts).
 */
export function useRun() {
  const api = useApi();
  const runs = useMemo(() => runsApi(api), [api]);
  const { save } = useFlowSave();

  const follow = useCallback(
    async (run: Pick<RunInfo, "run_id">) => {
      stopFollowing();
      const controller = new AbortController();
      following = controller;
      const ours = () => useRunStore.getState().runId === run.run_id;
      try {
        await followRun(runs, run.run_id, (event) => ours() && useRunStore.getState().apply(event), {
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted || !ours()) return;
        // The stream is gone; the stored record still says how the run went.
        try {
          useRunStore.getState().apply({ type: "snapshot", run: await runs.get(run.run_id) });
        } catch {
          useRunStore.getState().fail("Lost the connection to the run.");
        }
      } finally {
        if (following === controller) following = null;
      }
    },
    [runs],
  );

  /** Saves if needed; returns why the flow can't be run as saved, or null. */
  const ensureSaved = useCallback(async (): Promise<string | null> => {
    await saveSettled();
    if (useFlowStore.getState().dirty) {
      await save();
      await saveSettled();
    }
    const { dirty, save: state } = useFlowStore.getState();
    if (state.status === "conflict") {
      return "This flow was changed elsewhere. Resolve the conflict, then run it.";
    }
    if (dirty) return `Couldn't save the flow before running it${state.error ? `: ${state.error}` : "."}`;
    return null;
  }, [save]);

  const start = useCallback(
    async (triggerId?: string) => {
      const flowId = useFlowStore.getState().flowId;
      if (!flowId || isRunActive(useRunStore.getState().phase)) return;
      const store = useRunStore.getState();
      store.begin(flowId);

      const problem = await ensureSaved();
      if (problem) {
        store.fail(problem);
        toast.error(problem);
        return;
      }

      let run: RunInfo;
      try {
        run = await runs.start(flowId, triggerId ? { trigger_id: triggerId } : {});
      } catch (error) {
        const message = error instanceof ApiError ? error.message : "Can't reach the server.";
        const details = error instanceof ApiError ? issueMessages(error) : [];
        if (useRunStore.getState().flowId !== flowId) return;
        useRunStore.getState().fail(message, details);
        toast.error(message, details[0] ? { description: details[0] } : undefined);
        return;
      }
      if (useRunStore.getState().flowId !== flowId) return; // another flow was opened
      useRunStore.getState().attach(run);
      await follow(run);
    },
    [ensureSaved, follow, runs],
  );

  const stop = useCallback(async () => {
    const { runId, phase } = useRunStore.getState();
    if (!runId || !isRunActive(phase)) return;
    try {
      await runs.cancel(runId); // the stream reports the outcome
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Couldn't stop the run.");
    }
  }, [runs]);

  return { start, stop, follow };
}

/**
 * Ties the run to the open editor: a run of another flow is cleared, and leaving the editor stops
 * following the stream. Coming back to a flow whose run is still going replays it from the start
 * (the server keeps every event of a live run).
 */
export function useRunLifecycle(follow: (run: Pick<RunInfo, "run_id">) => Promise<void>) {
  const flowId = useFlowStore((s) => s.flowId);
  useEffect(() => {
    const run = useRunStore.getState();
    if (run.flowId !== flowId) {
      useRunStore.getState().reset();
    } else if (run.runId && isRunActive(run.phase)) {
      const runId = run.runId;
      useRunStore.setState({ ...IDLE_RUN, flowId, runId, phase: "running", panelOpen: run.panelOpen });
      void follow({ run_id: runId });
    }
    return stopFollowing;
  }, [flowId, follow]);
}
