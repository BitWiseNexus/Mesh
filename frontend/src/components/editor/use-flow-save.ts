"use client";

import { useReactFlow } from "@xyflow/react";
import { useCallback } from "react";
import { toast } from "sonner";

import { FIT_VIEW_OPTIONS } from "@/components/canvas/flow-canvas";
import { ApiError } from "@/lib/api";
import { toFlowContent } from "@/lib/flows-api";
import { useFetchLatestFlow, useSaveFlow } from "@/lib/flows-queries";
import { useFlowStore } from "@/stores/flow-store";

/**
 * Saves the open flow to the server with optimistic concurrency. On a version conflict (saved from
 * another tab/device) it offers to reload the latest version instead of silently overwriting it.
 */
export function useFlowSave() {
  const saveFlow = useSaveFlow();
  const fetchLatest = useFetchLatestFlow();
  const { fitView } = useReactFlow();

  const reload = useCallback(
    async (id: string) => {
      const latest = await fetchLatest(id);
      useFlowStore.getState().loadFlow(latest);
      requestAnimationFrame(() => void fitView(FIT_VIEW_OPTIONS));
      toast.success("Loaded the latest version");
    },
    [fetchLatest, fitView],
  );

  const save = useCallback(async () => {
    const state = useFlowStore.getState();
    if (!state.flowId || saveFlow.isPending) return;
    try {
      const saved = await saveFlow.mutateAsync({
        id: state.flowId,
        content: toFlowContent(state.toFlow()),
        expectedVersion: state.version ?? undefined,
      });
      useFlowStore.getState().markSaved(saved.version);
      toast.success("Saved");
    } catch (error) {
      if (error instanceof ApiError && error.code === "version_conflict") {
        const id = state.flowId;
        toast.error("This flow was changed in another tab or device.", {
          description: "Reload to get the latest version (your unsaved edits here will be lost).",
          action: { label: "Reload", onClick: () => void reload(id) },
          duration: Infinity,
        });
      } else {
        toast.error(error instanceof ApiError ? error.message : "Couldn't save the flow.");
      }
    }
  }, [saveFlow, reload]);

  return { save, isSaving: saveFlow.isPending };
}
