import type { XYPosition } from "@xyflow/react";

import { NODE_HEIGHT, NODE_WIDTH } from "@/lib/flow/graph";

type ScreenToFlow = (position: XYPosition) => XYPosition;

export const FIT_VIEW_OPTIONS = { maxZoom: 1, padding: 0.3 } as const;

/** Pixels React Flow's relative `padding` (0.3) leaves on each side of a `size`-px viewport. */
const relativePadding = (size: number) => Math.floor((size - size / (1 + FIT_VIEW_OPTIONS.padding)) / 2);

/**
 * Fit-view padding for a `width` × `height` canvas: the usual relative margin, plus whatever a
 * floating side panel covers on the left / right (e.g. the settings panel on narrow screens), so
 * the flow is fitted into the part of the canvas that's actually visible.
 */
export function fitPadding(width: number, height: number, cover: { left: number; right: number }) {
  const x = relativePadding(width - cover.left - cover.right);
  const y = relativePadding(height);
  return {
    top: `${y}px`,
    bottom: `${y}px`,
    left: `${x + cover.left}px`,
    right: `${x + cover.right}px`,
  } as const;
}

/** How far panels floating over the canvas reach into it from the left and from the right. */
export function coveredSides(canvas: DOMRect, panels: DOMRect[]): { left: number; right: number } {
  let left = 0;
  let right = 0;
  for (const p of panels) {
    const overlap = Math.min(canvas.right, p.right) - Math.max(canvas.left, p.left);
    if (overlap <= 0 || p.bottom <= canvas.top || p.top >= canvas.bottom) continue;
    if (p.left <= canvas.left) left = Math.max(left, p.right - canvas.left);
    else right = Math.max(right, canvas.right - p.left);
  }
  return { left, right };
}

/** dataTransfer key used when dragging a node type from the palette. */
export const DRAG_MIME = "application/x-mesh-node";

/**
 * Where the pointer is over the canvas (client coordinates), or null when it's elsewhere — e.g.
 * where Ctrl+V pastes. Updated by FlowCanvas; a plain object because nothing re-renders on it.
 */
export const canvasPointer: { client: XYPosition | null } = { client: null };

/**
 * The flow position at the middle of the visible canvas (e.g. where a clicked palette item goes).
 * `canvas` defaults to the editor's React Flow element; without one, the flow origin.
 */
export function getCanvasCenter(
  screenToFlowPosition: ScreenToFlow,
  canvas: Pick<Element, "getBoundingClientRect"> | null = document.querySelector(".react-flow"),
): XYPosition {
  if (!canvas) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  return screenToFlowPosition({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
}

/**
 * The id of the edge under a client point among `edgeIds` (e.g. the data edges), or null. Hit-tests
 * the DOM: an edge's wide, invisible interaction path counts, even under a dragged node.
 */
export function edgeAt(point: XYPosition, edgeIds: ReadonlySet<string>): string | null {
  for (const element of document.elementsFromPoint(point.x, point.y)) {
    const id = element.closest(".react-flow__edge")?.getAttribute("data-id");
    if (id && edgeIds.has(id)) return id;
  }
  return null;
}

/** The position (top-left corner) that centres a new node on `point`. */
export const centeredNodePosition = (point: XYPosition): XYPosition => ({
  x: point.x - NODE_WIDTH / 2,
  y: point.y - NODE_HEIGHT / 2,
});
