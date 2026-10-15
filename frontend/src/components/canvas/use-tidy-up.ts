"use client";

import { useCallback } from "react";

import { computeLayout } from "@/lib/flow/layout";
import { useFlowStore } from "@/stores/flow-store";

import { useFitView } from "./use-fit-view";

/** Auto-layout of the whole flow (one undo step), then fits it into view. */
export function useTidyUp() {
  const fit = useFitView();
  return useCallback(async () => {
    const { nodes, edges } = useFlowStore.getState();
    const positions = await computeLayout(nodes, edges);
    useFlowStore.getState().moveNodes(positions);
    fit();
  }, [fit]);
}
