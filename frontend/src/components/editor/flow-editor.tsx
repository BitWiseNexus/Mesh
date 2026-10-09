"use client";

import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect } from "react";
import { toast } from "sonner";

import { FlowCanvas } from "@/components/canvas/flow-canvas";
import { useFlowStore } from "@/stores/flow-store";
import { isRunActive, useRunStore } from "@/stores/run-store";

import { ConflictBanner, RecoveryBanner } from "./editor-banners";
import { EditorToolbar } from "./editor-toolbar";
import { NodeConfigPanel } from "./node-config-panel";
import { NodePalette } from "./node-palette";
import { RunPanel } from "./run-panel";
import { useAutosave } from "./use-autosave";
import { useFlowSave } from "./use-flow-save";
import { useRun, useRunLifecycle } from "./use-run";

const isEditableTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * Ctrl+S saves and Ctrl+Enter runs (even while typing); undo/redo shortcuts are ignored while
 * typing in a field.
 */
function useEditorShortcuts(save: () => void, run: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault(); // not the browser's "Save page" dialog
        save();
        return;
      }
      if (key === "enter") {
        event.preventDefault();
        run();
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
  }, [save, run]);
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
  const { start, stop, follow, show } = useRun();
  useRunLifecycle(follow);
  /** Ctrl+Enter: run when the flow is valid, has one trigger and nothing is running. */
  const runShortcut = useCallback(() => {
    const { issues, nodes } = useFlowStore.getState();
    const triggers = nodes.filter((n) => n.type.startsWith("trigger_"));
    if (isRunActive(useRunStore.getState().phase)) return;
    if (issues.some((i) => i.severity === "error")) {
      toast.error("Fix the flow's errors before running it.");
    } else if (triggers.length > 1) {
      toast.info("This flow has several triggers — choose one with Run.");
    } else {
      void start();
    }
  }, [start]);
  useEditorShortcuts(saveNow, runShortcut);

  const resolveRecovery = (restore: boolean) => {
    const { pendingRecovery: recovered, replaceContent } = useFlowStore.getState();
    if (restore && recovered) replaceContent(recovered);
    useFlowStore.setState({ pendingRecovery: null });
  };

  return (
    <div className="flex h-dvh flex-col">
      <EditorToolbar
        onSave={saveNow}
        onRun={(id) => void start(id)}
        onStop={() => void stop()}
        onShowRun={(id) => void show(id)}
      />
      <ConflictBanner
        onLoadLatest={() => void loadLatest()}
        onOverwrite={() => void save({ overwrite: true })}
      />
      <RecoveryBanner recovered={pendingRecovery} onResolve={resolveRecovery} />
      <div className="flex min-h-0 flex-1">
        <NodePalette />
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <FlowCanvas />
          </div>
          <RunPanel />
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
