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
import { cn } from "@/lib/utils";
import {
  edgeRunState,
  toolEdgeRunState,
  useRunStore,
  type EdgeRunState,
} from "@/stores/run-store";

const RUN_STROKE: Record<Exclude<EdgeRunState, null>, string> = {
  active: "var(--run-active)",
  delivered: "var(--run-done)",
  skipped: "var(--muted-foreground)",
};

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
  const { source, target, sourceHandleId } = props;
  const run = useRunStore((s) => edgeRunState(s.nodes, { source, target, sourceHandle: sourceHandleId }));
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        interactionWidth={20}
        className={cn(run === "active" && "mesh-edge-active")}
        data-run-state={run ?? undefined}
        style={{
          stroke: props.selected ? "var(--foreground)" : run ? RUN_STROKE[run] : "var(--muted-foreground)",
          strokeWidth: props.selected || run === "active" ? 2 : 1.5,
          opacity: run === "skipped" ? 0.35 : undefined,
          strokeDasharray: run === "skipped" ? "4 4" : undefined,
        }}
      />
      {props.selected && <DeleteEdgeButton id={props.id} x={labelX} y={labelY} />}
    </>
  );
}

/** Tool attachment: the agent can call the target as a tool. Not an execution step. */
export function ToolEdge(props: EdgeProps<CanvasEdge>) {
  const [path, labelX, labelY] = getBezierPath(props);
  const { target } = props;
  const run = useRunStore((s) => toolEdgeRunState(s.nodes, { target }));
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        interactionWidth={20}
        className={cn(run === "active" && "mesh-edge-active")}
        data-run-state={run ?? undefined}
        style={{
          stroke: run === "active" ? "var(--run-active)" : CATEGORIES.tool.color,
          strokeWidth: props.selected || run ? 2.5 : 1.5,
          // .mesh-edge-active sets its own dashes (and animates them).
          strokeDasharray: run === "active" ? undefined : "6 4",
        }}
      />
      {props.selected && <DeleteEdgeButton id={props.id} x={labelX} y={labelY} />}
    </>
  );
}
