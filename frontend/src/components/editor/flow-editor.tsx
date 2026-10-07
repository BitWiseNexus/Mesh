"use client";

import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useState } from "react";

import { FlowCanvas } from "@/components/canvas/flow-canvas";
import { useFlowStore } from "@/stores/flow-store";

import { EditorToolbar } from "./editor-toolbar";
import { NodeConfigPanel } from "./node-config-panel";
import { NodePalette } from "./node-palette";

const isEditableTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Global undo/redo shortcuts (ignored while typing in a field). */
function useHistoryShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const { undo, redo } = useFlowStore.getState();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** Restores the autosaved draft from localStorage before showing the canvas. */
function useDraftHydration(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const unsubscribe = useFlowStore.persist.onFinishHydration(() => setHydrated(true));
    void useFlowStore.persist.rehydrate();
    return unsubscribe;
  }, []);
  return hydrated;
}

export function FlowEditor() {
  const hydrated = useDraftHydration();
  useHistoryShortcuts();

  return (
    <ReactFlowProvider>
      <div className="flex h-dvh flex-col">
        <EditorToolbar />
        <div className="flex min-h-0 flex-1">
          <NodePalette />
          <main className="relative min-w-0 flex-1">
            {hydrated ? (
              <FlowCanvas />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading canvas…
              </div>
            )}
          </main>
          <NodeConfigPanel />
        </div>
      </div>
    </ReactFlowProvider>
  );
}
