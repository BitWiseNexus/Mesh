"use client";

import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect } from "react";
import { toast } from "sonner";

import { FlowCanvas } from "@/components/canvas/flow-canvas";
import { useFlowStore } from "@/stores/flow-store";

import { ConflictBanner, RecoveryBanner } from "./editor-banners";
import { EditorToolbar } from "./editor-toolbar";
import { NodeConfigPanel } from "./node-config-panel";
import { NodePalette } from "./node-palette";
import { useAutosave } from "./use-autosave";
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
  const { save, loadLatest } = useFlowSave();
  useAutosave(save);
  const pendingRecovery = useFlowStore((s) => s.pendingRecovery);

  /** Ctrl+S / clicking the save status: save now instead of waiting for autosave. */
  const saveNow = useCallback(() => {
    const { dirty, save: state } = useFlowStore.getState();
    if (state.status === "conflict") {
      toast.info("Resolve the conflict first: load the latest version or overwrite it.");
      return;
    }
    if (dirty || state.status === "error") void save();
  }, [save]);
  useEditorShortcuts(saveNow);

  const resolveRecovery = (restore: boolean) => {
    const { pendingRecovery: recovered, restoreLocal } = useFlowStore.getState();
    if (restore && recovered) restoreLocal(recovered);
    useFlowStore.setState({ pendingRecovery: null });
  };

  return (
    <div className="flex h-dvh flex-col">
      <EditorToolbar onSave={saveNow} />
      <ConflictBanner
        onLoadLatest={() => void loadLatest()}
        onOverwrite={() => void save({ overwrite: true })}
      />
      <RecoveryBanner recovered={pendingRecovery} onResolve={resolveRecovery} />
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
