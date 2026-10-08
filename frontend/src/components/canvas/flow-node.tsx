"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { memo, type CSSProperties } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CanvasNode } from "@/lib/flow/graph";
import type { FlowIssue } from "@/lib/flow/validate";
import {
  CATEGORIES,
  NODE_REGISTRY,
  nodeDisplayName,
  nodeRole,
  type HandleDef,
} from "@/lib/nodes/registry";
import { cn } from "@/lib/utils";
import { useFlowStore } from "@/stores/flow-store";

const handleClass =
  "size-3! border-2! border-background! transition-transform hover:scale-125!";

function DataHandle({ def, type }: { def: HandleDef; type: "source" | "target" }) {
  return (
    <Handle
      id={def.id}
      type={type}
      position={type === "source" ? Position.Right : Position.Left}
      className={cn(handleClass, "bg-muted-foreground!")}
    />
  );
}

function ToolHandle({ def, type }: { def: HandleDef; type: "source" | "target" }) {
  return (
    <Handle
      id={def.id}
      type={type}
      position={type === "source" ? Position.Bottom : Position.Top}
      className={cn(handleClass, "rounded-[3px]! bg-(--tool-accent)!")}
    />
  );
}

const NO_ISSUES: FlowIssue[] = [];

function IssueIndicator({ issues }: { issues: FlowIssue[] }) {
  const hasError = issues.some((i) => i.severity === "error");
  const Icon = hasError ? CircleAlert : TriangleAlert;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={`${issues.length} issue${issues.length === 1 ? "" : "s"}`}
            className={cn(
              "absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full border bg-background shadow-sm",
              hasError ? "text-destructive" : "text-amber-500",
            )}
          />
        }
      >
        <Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent side="top" className="flex-col items-start">
        {issues.map((i) => (
          <span key={i.id}>{i.message}</span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

function RoleBadge({ role }: { role: "start" | "end" }) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute -top-2.5 rounded-full bg-(--node-accent) px-1.5 py-0.5 text-[9px] leading-none font-semibold tracking-wider text-white uppercase",
        role === "start" ? "left-5" : "right-5",
      )}
    >
      {role}
    </span>
  );
}

function FlowNodeComponent({ id, type, data, selected }: NodeProps<CanvasNode>) {
  const def = NODE_REGISTRY[type];
  const category = CATEGORIES[def.category];
  const Icon = def.icon;
  const name = nodeDisplayName(type, data);
  const summary = def.summary?.(data);
  const role = nodeRole(type);
  const issues = useFlowStore((s) => s.nodeIssues[id] ?? NO_ISSUES);
  const hasError = issues.some((i) => i.severity === "error");

  const dataInputs = def.inputs.filter((h) => h.kind === "data");
  const toolInputs = def.inputs.filter((h) => h.kind === "tool");
  const dataOutputs = def.outputs.filter((h) => h.kind === "data");
  const toolOutputs = def.outputs.filter((h) => h.kind === "tool");
  const labelledOutputs = dataOutputs.length > 1;

  return (
    <div
      style={
        {
          "--node-accent": category.color,
          "--tool-accent": CATEGORIES.tool.color,
        } as CSSProperties
      }
      className={cn(
        "relative w-60 rounded-xl border bg-card text-card-foreground shadow-sm transition-shadow",
        // Start/end nodes get a rounded outer edge so a flow's entry and exit read at a glance.
        role === "start" && "rounded-l-[30px] pl-1.5",
        role === "end" && "rounded-r-[30px] pr-1.5",
        selected
          ? "border-(--node-accent) ring-2 ring-(--node-accent)/30"
          : cn("hover:shadow-md", hasError && "border-destructive/50"),
      )}
    >
      {role !== "step" && <RoleBadge role={role} />}
      {issues.length > 0 && <IssueIndicator issues={issues} />}

      {toolInputs.map((h) => (
        <ToolHandle key={h.id} def={h} type="target" />
      ))}

      <div className="flex items-center gap-2.5 p-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--node-accent)/15 text-(--node-accent)">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium leading-tight">{name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {summary ?? (name !== def.label ? def.label : category.label)}
          </div>
        </div>
      </div>

      {dataInputs.map((h) => (
        <DataHandle key={h.id} def={h} type="target" />
      ))}

      {labelledOutputs ? (
        <div className="flex flex-col gap-1 border-t px-3 py-2">
          {dataOutputs.map((h) => (
            // -mr-3/pr-3 stretches the row to the card edge so the handle sits on the border.
            <div key={h.id} className="relative -mr-3 pr-3 text-right text-xs text-muted-foreground">
              {h.label}
              <DataHandle def={h} type="source" />
            </div>
          ))}
        </div>
      ) : (
        dataOutputs.map((h) => <DataHandle key={h.id} def={h} type="source" />)
      )}

      {toolOutputs.map((h) => (
        <div key={h.id}>
          {/* Below the border and beside the handle: never crossed by the border, ring or tool edge. */}
          <span className="pointer-events-none absolute top-full left-1/2 mt-1 ml-2.5 text-[10px] leading-none font-medium text-(--tool-accent)">
            {h.label}
          </span>
          <ToolHandle def={h} type="source" />
        </div>
      ))}
    </div>
  );
}

export const FlowNode = memo(FlowNodeComponent);
