"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, History, Loader2, Square, X } from "lucide-react";
import { useMemo, useState } from "react";

import { useApi } from "@/components/auth/auth-provider";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatRelativeTime } from "@/lib/format";
import { runKeys, runsApi, type RunStatus, type RunSummary } from "@/lib/runs-api";
import { cn } from "@/lib/utils";
import { useFlowStore } from "@/stores/flow-store";
import { isRunActive, useRunStore } from "@/stores/run-store";

const STATUS: Record<RunStatus, { label: string; className: string }> = {
  queued: { label: "Starting", className: "text-sky-500" },
  running: { label: "Running", className: "text-sky-500" },
  succeeded: { label: "Succeeded", className: "text-emerald-600 dark:text-emerald-500" },
  failed: { label: "Failed", className: "text-destructive" },
  cancelled: { label: "Stopped", className: "text-muted-foreground" },
};

function StatusIcon({ status }: { status: RunStatus }) {
  const Icon = { queued: Loader2, running: Loader2, succeeded: Check, failed: X, cancelled: Square }[
    status
  ];
  return (
    <Icon
      className={cn("size-3.5", STATUS[status].className, isRunActive(status) && "animate-spin")}
    />
  );
}

function duration(run: RunSummary): string | null {
  if (!run.started_at || !run.finished_at) return null;
  const seconds = (Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds / 60)} min`;
}

/** Toolbar menu with the flow's latest runs; picking one shows it on the canvas. */
export function RunHistoryMenu({ onShow }: { onShow: (runId: string) => void }) {
  const api = useApi();
  const runs = useMemo(() => runsApi(api), [api]);
  const flowId = useFlowStore((s) => s.flowId);
  const version = useFlowStore((s) => s.version);
  const shownRun = useRunStore((s) => s.runId);
  const active = useRunStore((s) => isRunActive(s.phase));
  const [open, setOpen] = useState(false);
  const history = useQuery({
    queryKey: runKeys.list(flowId ?? ""),
    queryFn: () => runs.list(flowId!),
    enabled: open && flowId !== null,
  });

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Hint label={active ? "Run history (after this run)" : "Run history"}>
        <DropdownMenuTrigger
          disabled={active}
          render={<Button variant="ghost" size="icon-sm" aria-label="Run history" />}
        >
          <History />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Recent runs</DropdownMenuLabel>
          {history.isPending ? (
            <DropdownMenuItem disabled>
              <Loader2 className="animate-spin" />
              Loading…
            </DropdownMenuItem>
          ) : history.isError ? (
            <DropdownMenuItem disabled>Couldn&apos;t load the runs</DropdownMenuItem>
          ) : history.data.length === 0 ? (
            <DropdownMenuItem disabled>No runs yet — press Run</DropdownMenuItem>
          ) : (
            history.data.map((run) => (
              <DropdownMenuItem
                key={run.run_id}
                onClick={() => onShow(run.run_id)}
                className={cn("items-start", run.run_id === shownRun && "bg-muted")}
                aria-label={`${STATUS[run.status].label} run, ${formatRelativeTime(run.created_at)}`}
              >
                <span className="mt-0.5">
                  <StatusIcon status={run.status} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block">
                    {STATUS[run.status].label} · {formatRelativeTime(run.created_at)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[
                      duration(run),
                      version !== null && run.flow_version !== version
                        ? `flow version ${run.flow_version}`
                        : null,
                      run.error,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
