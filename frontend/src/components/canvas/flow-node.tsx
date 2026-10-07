"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo, type CSSProperties } from "react";

import type { CanvasNode } from "@/lib/flow/graph";
import { CATEGORIES, NODE_REGISTRY, nodeDisplayName, type HandleDef } from "@/lib/nodes/registry";
import { cn } from "@/lib/utils";

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

function FlowNodeComponent({ type, data, selected }: NodeProps<CanvasNode>) {
  const def = NODE_REGISTRY[type];
  const category = CATEGORIES[def.category];
  const Icon = def.icon;
  const name = nodeDisplayName(type, data);
  const summary = def.summary?.(data);

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
        selected
          ? "border-(--node-accent) ring-2 ring-(--node-accent)/30"
          : "hover:shadow-md",
      )}
    >
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
          {/* beside the handle so the label never sits on the tool edge */}
          <span className="pointer-events-none absolute bottom-0 left-1/2 ml-2.5 translate-y-1/2 text-[10px] leading-none font-medium text-(--tool-accent)">
            {h.label}
          </span>
          <ToolHandle def={h} type="source" />
        </div>
      ))}
    </div>
  );
}

export const FlowNode = memo(FlowNodeComponent);
