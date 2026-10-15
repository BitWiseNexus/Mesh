import { useSyncExternalStore } from "react";
import { create } from "zustand";

/** Below this width the side panels float over the canvas instead of squeezing it. */
export const NARROW_QUERY = "(max-width: 1099.98px)";

const PALETTE_KEY = "mesh:palette-open";

function readPaletteOpen(): boolean {
  try {
    return localStorage.getItem(PALETTE_KEY) !== "0";
  } catch {
    return true; // no storage (private window, SSR): open
  }
}

/**
 * Editor layout preferences of this viewer (not part of the flow). The palette has a separate
 * open state per mode: on wide screens the choice is remembered; on narrow ones it floats over
 * the canvas, so it starts hidden and closes again after adding a node.
 */
interface EditorUiState {
  wideOpen: boolean;
  narrowOpen: boolean;
  setPaletteOpen: (open: boolean, narrow: boolean) => void;
}

export const useEditorUi = create<EditorUiState>()((set) => ({
  wideOpen: typeof window === "undefined" ? true : readPaletteOpen(),
  narrowOpen: false,
  setPaletteOpen: (open, narrow) => {
    if (narrow) {
      set({ narrowOpen: open });
      return;
    }
    set({ wideOpen: open });
    try {
      localStorage.setItem(PALETTE_KEY, open ? "1" : "0");
    } catch {
      // not remembered
    }
  },
}));

function subscribeNarrow(onChange: () => void) {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the window is narrow (side panels float over the canvas). */
export function useIsNarrow(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

/** Whether the node palette is showing, for the current width, and a setter. */
export function usePalette(): [boolean, (open: boolean) => void] {
  const narrow = useIsNarrow();
  const open = useEditorUi((s) => (narrow ? s.narrowOpen : s.wideOpen));
  const setPaletteOpen = useEditorUi((s) => s.setPaletteOpen);
  return [open, (next) => setPaletteOpen(next, narrow)];
}

/** Closes the palette if it floats over the canvas (after adding a node from it). */
export function closeFloatingPalette() {
  if (window.matchMedia(NARROW_QUERY).matches) useEditorUi.getState().setPaletteOpen(false, true);
}
