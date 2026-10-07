"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
} from "@xyflow/react";
import { X } from "lucide-react";

import type { CanvasEdge } from "@/lib/flow/graph";
import { CATEGORIES } from "@/lib/nodes/registry";

function DeleteEdgeButton({ id, x, y }: { id: string; x: number; y: number }) {
  const { deleteElements } = useReactFlow();
  return (
    <EdgeLabelRenderer>
      <button
        type="button"
        aria-label="Delete connection"
        onClick={() => deleteElements({ edges: [{ id }] })}
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
        className="nodrag nopan pointer-events-auto absolute flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-destructive"
      >
        <X className="size-3" />
      </button>
    </EdgeLabelRenderer>
  );
}

/** Execution flow: output of the source feeds the target. */
export function DataEdge(props: EdgeProps<CanvasEdge>) {
  const [path, labelX, labelY] = getBezierPath(props);
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        interactionWidth={20}
        style={{
          stroke: props.selected ? "var(--foreground)" : "var(--muted-foreground)",
          strokeWidth: props.selected ? 2 : 1.5,
        }}
      />
      {props.selected && <DeleteEdgeButton id={props.id} x={labelX} y={labelY} />}
    </>
  );
}

/** Tool attachment: the agent can call the target as a tool. Not an execution step. */
export function ToolEdge(props: EdgeProps<CanvasEdge>) {
  const [path, labelX, labelY] = getBezierPath(props);
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        interactionWidth={20}
        style={{
          stroke: CATEGORIES.tool.color,
          strokeWidth: props.selected ? 2.5 : 1.5,
          strokeDasharray: "6 4",
        }}
      />
      {props.selected && <DeleteEdgeButton id={props.id} x={labelX} y={labelY} />}
    </>
  );
}
