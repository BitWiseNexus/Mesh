"use client";

import { useReactFlow, type XYPosition } from "@xyflow/react";
import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";

import { canvasPointer, getCanvasCenter } from "@/components/canvas/canvas-utils";
import {
  copyNodes,
  parseClipboard,
  serializeClipboard,
  type PasteTarget,
} from "@/lib/flow/clipboard";
import { useFlowStore } from "@/stores/flow-store";

/** The last copy made in this tab: what the context menu's Paste uses without clipboard access. */
let lastCopy: string | null = null;

export const isEditableTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Clipboard shortcuts belong to whatever has focus inside a dialog or menu, not to the canvas. */
export const inOverlay = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]');

/** Text selected on the page (e.g. in the run panel) is what Ctrl+C should copy. */
const hasTextSelection = () => !!window.getSelection()?.toString();

const selectedIds = () =>
  useFlowStore
    .getState()
    .nodes.filter((n) => n.selected)
    .map((n) => n.id);

const plural = (n: number) => `${n} node${n === 1 ? "" : "s"}`;

/** Copy / cut / paste / duplicate of the selected nodes, for shortcuts and menus. */
export function useNodeClipboard() {
  const { screenToFlowPosition } = useReactFlow();

  /** `at` (flow position) → there; else at the pointer if it's over the canvas; else centred. */
  const pasteTarget = useCallback(
    (at?: XYPosition): PasteTarget => {
      if (at) return { topLeft: at };
      if (canvasPointer.client) return { topLeft: screenToFlowPosition(canvasPointer.client) };
      return { center: getCanvasCenter(screenToFlowPosition) };
    },
    [screenToFlowPosition],
  );

  return useMemo(() => {
    /** The selection as clipboard text (also remembered for the context menu), or null. */
    const copy = (verb = "Copied"): string | null => {
      const { nodes, edges } = useFlowStore.getState();
      const clipboard = copyNodes(nodes, edges, new Set(selectedIds()));
      if (!clipboard) return null;
      lastCopy = serializeClipboard(clipboard);
      toast.success(`${verb} ${plural(clipboard.nodes.length)}`);
      return lastCopy;
    };

    const cut = (): string | null => {
      const ids = selectedIds();
      const text = copy("Cut");
      if (text) useFlowStore.getState().deleteNodes(ids);
      return text;
    };

    /** Pastes Mesh clipboard text; false (nothing happens) for any other text. */
    const paste = (text: string, at?: XYPosition): boolean => {
      const clipboard = parseClipboard(text);
      if (!clipboard) return false;
      const problem = useFlowStore.getState().pasteNodes(clipboard, pasteTarget(at));
      if (problem) toast.error(problem);
      return true;
    };

    /** Context menu: the system clipboard when the browser lets us read it, else this tab's copy. */
    const pasteFromMenu = async (at?: XYPosition) => {
      let text: string | null = null;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        // permission denied or unsupported
      }
      if (!(text && paste(text, at)) && !(lastCopy && paste(lastCopy, at))) {
        toast.info("Nothing to paste — copy some nodes first.");
      }
    };

    /** Context menu: copy to the system clipboard too (best effort; this tab remembers it anyway). */
    const copyFromMenu = (cutToo = false) => {
      const text = cutToo ? cut() : copy();
      if (text) void navigator.clipboard?.writeText(text).catch(() => {});
    };

    const duplicate = () => {
      const problem = useFlowStore.getState().duplicateNodes(selectedIds());
      if (problem) toast.error(problem);
    };

    return { copy, cut, paste, pasteFromMenu, copyFromMenu, duplicate };
  }, [pasteTarget]);
}

/**
 * Ctrl+C / Ctrl+X / Ctrl+V on the canvas through the browser's clipboard events (no permission
 * prompt; copies travel between tabs and flows), and Ctrl+D to duplicate. Typing in fields, text
 * selected on the page, dialogs and menus keep the browser's normal behaviour.
 */
export function useClipboardShortcuts() {
  const { copy, cut, paste, duplicate } = useNodeClipboard();

  useEffect(() => {
    const canvasCopy = (event: ClipboardEvent, action: () => string | null) => {
      if (isEditableTarget(event.target) || inOverlay(event.target) || hasTextSelection()) return;
      const text = action();
      if (!text || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
    };
    const onCopy = (event: ClipboardEvent) => canvasCopy(event, () => copy());
    const onCut = (event: ClipboardEvent) => canvasCopy(event, cut);
    const onPaste = (event: ClipboardEvent) => {
      if (isEditableTarget(event.target) || inOverlay(event.target)) return;
      const text = event.clipboardData?.getData("text/plain");
      if (text && paste(text)) event.preventDefault();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "d") return;
      if (isEditableTarget(event.target) || inOverlay(event.target)) return;
      event.preventDefault(); // not the browser's "bookmark this page"
      duplicate();
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [copy, cut, paste, duplicate]);
}
