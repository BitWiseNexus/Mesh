"use client";

import { AlertTriangle, History } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Flow } from "@/types/flow";
import { useFlowStore } from "@/stores/flow-store";

function Banner({
  icon,
  children,
  actions,
  label,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  actions: React.ReactNode;
  label: string;
}) {
  return (
    <div
      role="alert"
      aria-label={label}
      className="flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm"
    >
      {icon}
      <p className="min-w-0 flex-1">{children}</p>
      <div className="flex gap-2">{actions}</div>
    </div>
  );
}

/** Shown when a save was rejected because the flow changed in another tab or device. */
export function ConflictBanner({
  onLoadLatest,
  onOverwrite,
}: {
  onLoadLatest: () => void;
  onOverwrite: () => void;
}) {
  const conflict = useFlowStore((s) => s.save.status === "conflict");
  if (!conflict) return null;
  return (
    <Banner
      label="Save conflict"
      icon={<AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-500" />}
      actions={
        <>
          <Button size="sm" variant="outline" onClick={onLoadLatest}>
            Load latest
          </Button>
          <Button size="sm" onClick={onOverwrite}>
            Overwrite with mine
          </Button>
        </>
      }
    >
      <strong>This flow was changed in another tab or device.</strong> Your latest edits here
      aren&apos;t saved. Load the latest version (discarding your edits) or overwrite it with yours.
    </Banner>
  );
}

/**
 * Shown when this browser holds unsaved edits that were made on a different version of the flow
 * than the one on the server, so restoring them would replace newer changes.
 */
export function RecoveryBanner({
  recovered,
  onResolve,
}: {
  recovered: Flow | null;
  onResolve: (restore: boolean) => void;
}) {
  if (!recovered) return null;
  return (
    <Banner
      label="Unsaved changes found"
      icon={<History className="size-4 shrink-0 text-amber-600 dark:text-amber-500" />}
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => onResolve(false)}>
            Keep saved version
          </Button>
          <Button size="sm" onClick={() => onResolve(true)}>
            Restore my changes
          </Button>
        </>
      }
    >
      <strong>This browser has unsaved changes to this flow</strong>, made before it was updated
      elsewhere. Restoring them replaces the saved version.
    </Banner>
  );
}
