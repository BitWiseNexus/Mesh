"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
} from "@xyflow/react";
import { Plus, X } from "lucide-react";

import type { CanvasEdge } from "@/lib/flow/graph";
import { CATEGORIES } from "@/lib/nodes/registry";
import { cn } from "@/lib/utils";
import { useCanvasUi } from "@/stores/canvas-ui-store";
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

/**
 * A data edge's look: its stroke colour, and the arrowhead marker drawn in that colour. `insert`:
 * a node being dragged over it would be inserted into it.
 */
type DataEdgeLook = "default" | "selected" | "insert" | Exclude<EdgeRunState, null>;

const LOOK_STROKE: Record<DataEdgeLook, string> = {
  default: "var(--muted-foreground)",
  selected: "var(--foreground)",
  insert: "var(--primary)",
  ...RUN_STROKE,
};

export const arrowMarkerId = (look: DataEdgeLook) => `mesh-arrow-${look}`;

/**
 * Arrowheads for data edges (execution direction), one per colour: an SVG marker can't take its
 * colour from the edge using it. Rendered once inside the canvas. Tool edges have none — they
 * attach a tool to an agent rather than pass data along.
 */
export function EdgeMarkers() {
  return (
    <svg aria-hidden className="absolute size-0">
      <defs>
        {(Object.keys(LOOK_STROKE) as DataEdgeLook[]).map((look) => (
          <marker
            key={look}
            id={arrowMarkerId(look)}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="10"
            markerHeight="10"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 9 5 L 0 9 z" style={{ fill: LOOK_STROKE[look] }} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

const edgeButton =
  "flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm";

/**
 * Buttons on a selected edge's midpoint (`x`, `y`, flow coordinates): delete it, and for data
 * edges insert a node into it (opens the node picker).
 */
function EdgeActions({ id, x, y, insert }: { id: string; x: number; y: number; insert: boolean }) {
  const { deleteElements } = useReactFlow();
  const openPicker = useCanvasUi((s) => s.openPicker);
  return (
    <EdgeLabelRenderer>
      <div
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
        className="nodrag nopan pointer-events-auto absolute flex gap-1"
      >
        {insert && (
          <button
            type="button"
            aria-label="Insert a node"
            title="Insert a node"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              openPicker({
                client: { x: rect.right, y: rect.top },
                point: { x, y },
                link: { kind: "split", edgeId: id },
              });
            }}
            className={cn(edgeButton, "hover:text-foreground")}
          >
            <Plus className="size-3" />
          </button>
        )}
        <button
          type="button"
          aria-label="Delete connection"
          title="Delete connection"
          onClick={() => deleteElements({ edges: [{ id }] })}
          className={cn(edgeButton, "hover:text-destructive")}
        >
          <X className="size-3" />
        </button>
      </div>
    </EdgeLabelRenderer>
  );
}

/** Execution flow: output of the source feeds the target. */
export function DataEdge(props: EdgeProps<CanvasEdge>) {
  const [path, labelX, labelY] = getBezierPath(props);
  const { source, target, sourceHandleId } = props;
  const run = useRunStore((s) => edgeRunState(s.nodes, { source, target, sourceHandle: sourceHandleId }));
  const insertTarget = useCanvasUi((s) => s.insertEdgeId === props.id);
  const look: DataEdgeLook = insertTarget
    ? "insert"
    : props.selected
      ? "selected"
      : (run ?? "default");
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={`url(#${arrowMarkerId(look)})`}
        interactionWidth={20}
        className={cn(run === "active" && "mesh-edge-active")}
        data-run-state={run ?? undefined}
        style={{
          stroke: LOOK_STROKE[look],
          strokeWidth: insertTarget ? 3 : props.selected || run === "active" ? 2 : 1.5,
          opacity: run === "skipped" ? 0.35 : undefined,
          strokeDasharray: run === "skipped" ? "4 4" : undefined,
        }}
      />
      {props.selected && <EdgeActions id={props.id} x={labelX} y={labelY} insert />}
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
      {props.selected && <EdgeActions id={props.id} x={labelX} y={labelY} insert={false} />}
    </>
  );
}
