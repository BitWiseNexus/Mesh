"use client";

import { useEffect, useRef } from "react";

import { useFlowStore } from "@/stores/flow-store";

/** Idle time after the last edit before autosaving. */
export const AUTOSAVE_DELAY_MS = 1500;
/** Backoff between automatic retries after a failed save (last value repeats). */
export const RETRY_DELAYS_MS = [2000, 5000, 15000, 30000];

/**
 * Saves the open flow automatically:
 * - `AUTOSAVE_DELAY_MS` after the last edit (each edit restarts the timer),
 * - with backoff retries after retryable failures (not after validation errors or conflicts),
 * - immediately when the editor is left (in-app navigation hides/unmounts it),
 * and asks before closing the tab while changes aren't saved yet.
 */
export function useAutosave(save: () => Promise<void>) {
  const fingerprint = useFlowStore((s) => s.fingerprint);
  const dirty = useFlowStore((s) => s.dirty);
  const status = useFlowStore((s) => s.save.status);
  const retryable = useFlowStore((s) => s.save.retryable);
  const failures = useFlowStore((s) => s.save.failures);

  // Debounced save; `fingerprint` in the deps restarts the timer on every edit.
  useEffect(() => {
    if (!dirty || status === "saving" || status === "conflict") return;
    if (status === "error" && !retryable) return;
    const delay =
      status === "error"
        ? RETRY_DELAYS_MS[Math.min(failures - 1, RETRY_DELAYS_MS.length - 1)]
        : AUTOSAVE_DELAY_MS;
    const timer = setTimeout(() => void save(), delay);
    return () => clearTimeout(timer);
  }, [dirty, status, retryable, failures, fingerprint, save]);

  // Leaving the editor (navigation hides or unmounts it): save what's pending right away.
  // The mutation outlives the component; markSaved ignores it if another flow is open by then.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(
    () => () => {
      const { dirty, save: state } = useFlowStore.getState();
      if (dirty && state.status !== "saving" && state.status !== "conflict") {
        void saveRef.current();
      }
    },
    [],
  );

  // Closing/reloading the tab with unsaved work: let the browser ask for confirmation.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const { dirty, save: state } = useFlowStore.getState();
      if (dirty || state.status === "saving") {
        event.preventDefault();
        event.returnValue = ""; // older browsers need a value to show the prompt
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
}
