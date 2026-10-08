"use client";

import { ReactFlowProvider } from "@xyflow/react";
import { useEffect } from "react";

import { FlowCanvas } from "@/components/canvas/flow-canvas";
import { useFlowStore } from "@/stores/flow-store";

import { EditorToolbar } from "./editor-toolbar";
import { NodeConfigPanel } from "./node-config-panel";
import { NodePalette } from "./node-palette";
import { useFlowSave } from "./use-flow-save";

const isEditableTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Ctrl+S saves (even while typing); undo/redo shortcuts are ignored while typing in a field. */
function useEditorShortcuts(save: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault(); // not the browser's "Save page" dialog
        save();
        return;
      }
      if (isEditableTarget(event.target)) return;
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
  }, [save]);
}

function EditorLayout() {
  const { save, isSaving } = useFlowSave();
  useEditorShortcuts(save);

  return (
    <div className="flex h-dvh flex-col">
      <EditorToolbar onSave={() => void save()} isSaving={isSaving} />
      <div className="flex min-h-0 flex-1">
        <NodePalette />
        <main className="relative min-w-0 flex-1">
          <FlowCanvas />
        </main>
        <NodeConfigPanel />
      </div>
    </div>
  );
}

/** The editor for the flow currently loaded into the store (see FlowEditorRoute). */
export function FlowEditor() {
  return (
    <ReactFlowProvider>
      <EditorLayout />
    </ReactFlowProvider>
  );
}
