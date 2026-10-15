import type { XYPosition } from "@xyflow/react";
import { create } from "zustand";

import type { NodeLink } from "@/lib/flow/connect";

/** An open node picker: where it shows (client coordinates), where the node goes, its link. */
export interface PickerRequest {
  client: XYPosition;
  /** Flow position the new node is placed at (see `placementFor`). */
  point: XYPosition;
  link?: NodeLink;
}

/**
 * Transient canvas UI state shared by the canvas, its edges and menus — never part of the flow,
 * never saved, not undoable.
 */
interface CanvasUiState {
  picker: PickerRequest | null;
  /** The data edge a node would be inserted into if dropped now (highlighted while dragging). */
  insertEdgeId: string | null;
  openPicker: (request: PickerRequest) => void;
  closePicker: () => void;
  setInsertEdge: (id: string | null) => void;
}

export const useCanvasUi = create<CanvasUiState>()((set, get) => ({
  picker: null,
  insertEdgeId: null,
  openPicker: (picker) => set({ picker }),
  closePicker: () => set({ picker: null }),
  setInsertEdge: (id) => {
    if (get().insertEdgeId !== id) set({ insertEdgeId: id });
  },
}));
