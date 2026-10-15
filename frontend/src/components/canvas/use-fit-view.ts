"use client";

import { useReactFlow } from "@xyflow/react";
import { useCallback } from "react";

import { coveredSides, FIT_VIEW_OPTIONS, fitPadding } from "./canvas-utils";

/** The side panels that may float over the canvas on narrow screens. */
const PANELS = '[aria-label="Node palette"], [aria-label="Node settings"]';

/**
 * Fits the flow (or `nodes`) into the part of the canvas that's visible. Waits two frames first:
 * selecting a node opens the settings panel, which resizes the canvas (wide screens) or covers
 * part of it (narrow ones) — fitting right away used the old size and could hide the node behind
 * the panel.
 */
export function useFitView() {
  const { fitView } = useReactFlow();
  return useCallback(
    (options: { nodes?: { id: string }[]; duration?: number } = {}) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const canvas = document.querySelector(".react-flow")?.getBoundingClientRect();
          if (!canvas) return;
          const panels = [...document.querySelectorAll(PANELS)].map((p) => p.getBoundingClientRect());
          const cover = coveredSides(canvas, panels);
          void fitView({
            maxZoom: FIT_VIEW_OPTIONS.maxZoom,
            duration: 300,
            ...options,
            padding: fitPadding(canvas.width, canvas.height, cover),
          });
        }),
      );
    },
    [fitView],
  );
}
