"use client";

import { AlertTriangle, Check, CircleAlert, Loader2, RotateCw } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/lib/format";
import { useFlowStore } from "@/stores/flow-store";

/**
 * Save state in the toolbar. Autosave does the work; this shows what's happening and offers
 * "save now" / "retry". The text is announced politely to screen readers.
 */
export function SaveStatus({ onSave }: { onSave: () => void }) {
  const dirty = useFlowStore((s) => s.dirty);
  const { status, error, lastSavedAt } = useFlowStore((s) => s.save);

  let content: React.ReactNode;
  if (status === "saving") {
    content = (
      <span className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Saving…
      </span>
    );
  } else if (status === "conflict") {
    content = (
      <span className="flex items-center gap-1.5 px-2 text-xs text-amber-600 dark:text-amber-500">
        <AlertTriangle className="size-3.5" />
        Not saved — conflict
      </span>
    );
  } else if (status === "error") {
    content = (
      <Hint label={error ?? "Saving failed"}>
        <Button variant="ghost" size="sm" onClick={onSave} className="text-destructive">
          <CircleAlert />
          Couldn&apos;t save
          <RotateCw className="opacity-70" />
          <span className="sr-only">— retry</span>
        </Button>
      </Hint>
    );
  } else if (dirty) {
    content = (
      <Hint label="Saves automatically · Ctrl+S to save now">
        <Button variant="ghost" size="sm" onClick={onSave} className="text-muted-foreground">
          <span className="size-2 rounded-full bg-amber-500" aria-hidden />
          Unsaved changes
        </Button>
      </Hint>
    );
  } else {
    content = (
      <span
        className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground"
        title={lastSavedAt ? `Saved ${formatRelativeTime(new Date(lastSavedAt))}` : undefined}
      >
        <Check className="size-3.5 text-emerald-600 dark:text-emerald-500" />
        Saved
      </span>
    );
  }

  return (
    <div role="status" aria-live="polite" aria-label="Save status" className="flex items-center">
      {content}
    </div>
  );
}
