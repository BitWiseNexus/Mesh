"use client";

import { Check, Loader2, Minus, Square, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { NODE_REGISTRY, nodeDisplayName } from "@/lib/nodes/registry";
import type { NodeRunStatus } from "@/lib/runs-api";
import { cn } from "@/lib/utils";
import { useFlowStore } from "@/stores/flow-store";
import {
  isRunActive,
  useRunStore,
  type NodeRun,
  type RunPhase,
  type ToolCallRun,
} from "@/stores/run-store";
import type { NodeType } from "@/types/flow";

/** A node output as text: strings as they are, anything else as indented JSON. */
export function formatOutput(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

const PHASE: Record<RunPhase, { label: string; className: string }> = {
  idle: { label: "", className: "" },
  starting: { label: "Starting…", className: "text-sky-600 dark:text-sky-400" },
  queued: { label: "Starting…", className: "text-sky-600 dark:text-sky-400" },
  running: { label: "Running…", className: "text-sky-600 dark:text-sky-400" },
  succeeded: { label: "Succeeded", className: "text-emerald-600 dark:text-emerald-500" },
  failed: { label: "Failed", className: "text-destructive" },
  cancelled: { label: "Stopped", className: "text-muted-foreground" },
};

function StatusIcon({ status, className }: { status: NodeRunStatus; className?: string }) {
  const props = { className: cn("size-3.5 shrink-0", className) };
  switch (status) {
    case "running":
      return <Loader2 {...props} className={cn(props.className, "animate-spin text-sky-500")} />;
    case "succeeded":
      return <Check {...props} className={cn(props.className, "text-emerald-600 dark:text-emerald-500")} />;
    case "failed":
      return <X {...props} className={cn(props.className, "text-destructive")} />;
    case "cancelled":
      return <Square {...props} className={cn(props.className, "text-muted-foreground")} />;
    default:
      return <Minus {...props} className={cn(props.className, "text-muted-foreground")} />;
  }
}

function seconds(from?: string | null, to?: string | null): string | null {
  if (!from) return null;
  const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from);
  return ms < 0 ? null : `${(ms / 1000).toFixed(1)} s`;
}

/** Elapsed time, ticking while the run is going. */
function Elapsed({ from, to }: { from: string | null; to: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!from || to) return;
    const timer = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(timer);
  }, [from, to]);
  const text = seconds(from, to);
  return text ? <span className="tabular-nums text-muted-foreground">{text}</span> : null;
}

/** Display names and types by node id, as a stable string (no re-render on drags). */
function useNodeInfo(): Record<string, { name: string; type: NodeType }> {
  const key = useFlowStore((s) =>
    JSON.stringify(
      Object.fromEntries(s.nodes.map((n) => [n.id, { name: nodeDisplayName(n.type, n.data), type: n.type }])),
    ),
  );
  return useMemo(() => JSON.parse(key), [key]);
}

/** A scroll area that stays pinned to the bottom as `content` grows, unless scrolled up. */
function StickToBottom({
  content,
  className,
  children,
}: {
  content: unknown;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [content]);
  const onScroll = () => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  };
  return (
    <div ref={ref} onScroll={onScroll} className={cn("min-h-0 flex-1 overflow-auto p-3", className)}>
      {children}
    </div>
  );
}

/** One line per argument value, shortened: `query: "cats"`. */
function formatArguments(args: unknown): string {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const parts = Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    return parts.join(", ");
  }
  return typeof args === "string" ? args : JSON.stringify(args);
}

const shorten = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text);

function ToolCalls({ calls }: { calls: ToolCallRun[] }) {
  return (
    <ul aria-label="Tool calls" className="mt-1.5 flex flex-col gap-1">
      {calls.map((call) => (
        <li key={call.callId} className="rounded-md bg-muted/60 px-2 py-1 text-xs">
          <div className="flex items-center gap-1.5">
            <Wrench className="size-3 shrink-0 text-muted-foreground" />
            <span className="font-medium">{call.name}</span>
            <span className="min-w-0 truncate text-muted-foreground">
              ({shorten(formatArguments(call.arguments), 120)})
            </span>
            <span className="ml-auto">
              <StatusIcon status={call.status} />
            </span>
          </div>
          {call.status === "failed" && call.error && (
            <p className="mt-0.5 text-destructive">{call.error}</p>
          )}
          {call.status === "succeeded" && (
            <p className="mt-0.5 break-words whitespace-pre-wrap text-muted-foreground">
              {shorten(formatOutput(call.output))}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function NodeOutput({ id, run, name, type }: { id: string; run: NodeRun; name: string; type?: NodeType }) {
  const isResult = type === "output_display";
  const body =
    run.status === "running" || (run.text && typeof run.output === "string")
      ? run.text
      : formatOutput(run.output);
  return (
    <li
      aria-label={`${name} output`}
      data-node-id={id}
      className={cn("rounded-lg border px-3 py-2", isResult && "border-emerald-500/40 bg-emerald-500/5")}
    >
      <div className="flex items-center gap-2 text-xs">
        <StatusIcon status={run.status} />
        <span className="font-medium">{name}</span>
        {isResult && (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 uppercase dark:text-emerald-400">
            Result
          </span>
        )}
        <span className="text-muted-foreground">{type ? NODE_REGISTRY[type].label : ""}</span>
        <span className="ml-auto tabular-nums text-muted-foreground">
          {run.calls ? `called ${run.calls}× · ` : ""}
          {run.status === "skipped" ? "skipped" : seconds(run.startedAt, run.finishedAt)}
        </span>
      </div>
      {run.toolCalls && run.toolCalls.length > 0 && <ToolCalls calls={run.toolCalls} />}
      {run.error && <p className="mt-1.5 text-sm text-destructive">{run.error}</p>}
      {body && (
        <pre className="mt-1.5 max-h-64 overflow-auto font-sans text-sm whitespace-pre-wrap break-words">
          {body}
          {run.status === "running" && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground/60 align-middle" />}
        </pre>
      )}
      {run.outputTruncated && (
        <p className="mt-1 text-xs text-muted-foreground">Output shortened — it was too long to keep.</p>
      )}
    </li>
  );
}

function OutputTab() {
  const order = useRunStore((s) => s.order);
  const nodes = useRunStore((s) => s.nodes);
  const error = useRunStore((s) => s.error);
  const info = useNodeInfo();
  const textLength = order.reduce((n, id) => n + (nodes[id]?.text.length ?? 0), 0);
  return (
    <StickToBottom content={`${order.length}:${textLength}:${error}`}>
      {order.length === 0 && !error && <p className="text-sm text-muted-foreground">Waiting for the first node…</p>}
      <ol className="flex flex-col gap-2">
        {order.map((id) => (
          <NodeOutput
            key={id}
            id={id}
            run={nodes[id]}
            name={info[id]?.name ?? id}
            type={info[id]?.type}
          />
        ))}
      </ol>
      {error && (
        <p role="alert" id="run-error" className="mt-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </StickToBottom>
  );
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 1 } as Intl.DateTimeFormatOptions);

function LogsTab() {
  const log = useRunStore((s) => s.log);
  const info = useNodeInfo();
  return (
    <StickToBottom content={log.length} className="font-mono text-xs">
      <ol aria-label="Run log">
        {log.map((entry, i) => (
          <li
            key={i}
            className={cn(
              "flex gap-3 py-0.5",
              entry.level === "error" && "text-destructive",
              entry.level === "warning" && "text-amber-600 dark:text-amber-500",
            )}
          >
            <span className="shrink-0 text-muted-foreground tabular-nums">{time(entry.at)}</span>
            <span className="break-words">
              {entry.nodeId && <span className="font-semibold">{info[entry.nodeId]?.name ?? entry.nodeId}: </span>}
              {entry.message}
            </span>
          </li>
        ))}
      </ol>
    </StickToBottom>
  );
}

function Tab({ id, active, onSelect, children }: { id: string; active: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      id={`run-tab-${id}`}
      aria-selected={active}
      aria-controls={`run-tabpanel-${id}`}
      onClick={onSelect}
      className={cn(
        "rounded-md px-2 py-1 text-xs font-medium",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** The run drawer under the canvas: per-node output (streamed live) and the run's log. */
export function RunPanel() {
  const open = useRunStore((s) => s.panelOpen && s.phase !== "idle");
  const phase = useRunStore((s) => s.phase);
  const startedAt = useRunStore((s) => s.startedAt);
  const finishedAt = useRunStore((s) => s.finishedAt);
  const [tab, setTab] = useState<"output" | "logs">("output");
  if (!open) return null;

  return (
    <section aria-label="Run" className="flex h-72 shrink-0 flex-col border-t bg-background">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b px-3 text-sm">
        <span role="status" aria-label="Run status" className={cn("flex items-center gap-1.5 font-medium", PHASE[phase].className)}>
          {isRunActive(phase) && <Loader2 className="size-3.5 animate-spin" />}
          {PHASE[phase].label}
        </span>
        <Elapsed from={startedAt} to={finishedAt} />
        <div role="tablist" aria-label="Run details" className="ml-2 flex gap-1">
          <Tab id="output" active={tab === "output"} onSelect={() => setTab("output")}>
            Output
          </Tab>
          <Tab id="logs" active={tab === "logs"} onSelect={() => setTab("logs")}>
            Logs
          </Tab>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Close run panel"
          onClick={() => useRunStore.getState().setPanelOpen(false)}
        >
          <X />
        </Button>
      </header>
      <div role="tabpanel" id={`run-tabpanel-${tab}`} aria-labelledby={`run-tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
        {tab === "output" ? <OutputTab /> : <LogsTab />}
      </div>
    </section>
  );
}
