"use client";

import { useReactFlow } from "@xyflow/react";
import { useCallback } from "react";
import { toast } from "sonner";

import { FIT_VIEW_OPTIONS } from "@/components/canvas/flow-canvas";
import { ApiError } from "@/lib/api";
import { contentFingerprint } from "@/lib/flow/fingerprint";
import { toFlowContent } from "@/lib/flows-api";
import { useFetchLatestFlow, useSaveFlow } from "@/lib/flows-queries";
import { useFlowStore } from "@/stores/flow-store";

/** Errors a retry can fix: network failures, timeouts, rate limits and server errors. */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true; // fetch threw → network/CORS/offline
  return error.status >= 500 || error.status === 408 || error.status === 429 || error.status === 401;
}

/**
 * One save of the open flow, with optimistic concurrency (`expected_version`). Status lives in the
 * store (`save`, `dirty`) so the toolbar and autosave share it. Never throws.
 */
export function useFlowSave() {
  // mutateAsync is stable across renders (the useMutation result object isn't), which keeps
  // `save` stable so autosave's timer only restarts on real edits.
  const { mutateAsync } = useSaveFlow();
  const fetchLatest = useFetchLatestFlow();
  const { fitView } = useReactFlow();

  const save = useCallback(
    async ({ overwrite = false }: { overwrite?: boolean } = {}) => {
      const state = useFlowStore.getState();
      const id = state.flowId;
      if (!id || state.save.status === "saving") return;
      if (state.save.status === "conflict" && !overwrite) return; // the banner asks the user

      const content = toFlowContent(state.toFlow());
      const fingerprint = contentFingerprint(content);
      state.setSave({ status: "saving" });
      try {
        const saved = await mutateAsync({
          id,
          content,
          expectedVersion: overwrite ? undefined : (state.version ?? undefined),
        });
        useFlowStore.getState().markSaved(id, saved.version, fingerprint);
      } catch (error) {
        const current = useFlowStore.getState();
        if (current.flowId !== id) return; // user already moved on to another flow
        if (error instanceof ApiError && error.code === "version_conflict") {
          current.setSave({ status: "conflict", error: null });
          return;
        }
        current.setSave({
          status: "error",
          error: error instanceof ApiError ? error.message : "Can't reach the server.",
          retryable: isRetryable(error),
          failures: current.save.failures + 1,
        });
      }
    },
    [mutateAsync],
  );

  /** Discards local content and loads the latest saved version (conflict resolution). */
  const loadLatest = useCallback(async () => {
    const id = useFlowStore.getState().flowId;
    if (!id) return;
    try {
      const latest = await fetchLatest(id);
      useFlowStore.getState().loadFlow(latest);
      requestAnimationFrame(() => void fitView(FIT_VIEW_OPTIONS));
      toast.success("Loaded the latest version");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Couldn't load the latest version.");
    }
  }, [fetchLatest, fitView]);

  return { save, loadLatest };
}
