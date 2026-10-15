/**
 * Adding a node *linked* to the flow: connected to a handle a connection was dragged from, or
 * inserted into an existing edge (A → B becomes A → new → B). Pure; the store applies the result
 * as one undo step and the node picker uses `pickableTypes` to offer only nodes that fit.
 */
import type { XYPosition } from "@xyflow/react";

import { NODE_REGISTRY, NODES_BY_CATEGORY, type HandleDef } from "@/lib/nodes/registry";
import type { NodeType } from "@/types/flow";

import {
  checkConnection,
  createEdge,
  findHandle,
  NODE_HEIGHT,
  NODE_WIDTH,
  type CanvasEdge,
  type CanvasNode,
} from "./graph";

/** A handle on an existing node: where a connection was dragged from. */
export interface HandleRef {
  nodeId: string;
  handleId: string | null;
  /** `source` = an output (the new node goes after it), `target` = an input (before it). */
  handleType: "source" | "target";
}

export type NodeLink =
  | { kind: "connect"; from: HandleRef }
  /** Insert into this data edge. */
  | { kind: "split"; edgeId: string };

/** Node types that can be added (not "Soon", not retired), in palette order. */
export const ADDABLE_TYPES: NodeType[] = NODES_BY_CATEGORY.flatMap((g) =>
  g.nodes.filter((n) => !n.comingSoon).map((n) => n.type),
);

/** The new node's handle a connection from `from` would attach to: same kind, opposite side. */
export function matchingHandle(
  from: HandleRef,
  nodes: CanvasNode[],
  type: NodeType,
): HandleDef | undefined {
  const fromNode = nodes.find((n) => n.id === from.nodeId);
  const fromHandle = fromNode && findHandle(fromNode, from.handleId, from.handleType);
  if (!fromHandle) return undefined;
  const def = NODE_REGISTRY[type];
  return (from.handleType === "source" ? def.inputs : def.outputs).find(
    (h) => h.kind === fromHandle.kind,
  );
}

/** Can a node of `type` go into the middle of a data edge (one data input, one data output)? */
export const canSplitWith = (type: NodeType): boolean => {
  const def = NODE_REGISTRY[type];
  return def.inputs.some((h) => h.kind === "data") && def.outputs.some((h) => h.kind === "data");
};

/** The node types a picker for `link` offers. */
export function pickableTypes(link: NodeLink | undefined, nodes: CanvasNode[]): NodeType[] {
  if (!link) return ADDABLE_TYPES;
  if (link.kind === "split") return ADDABLE_TYPES.filter(canSplitWith);
  return ADDABLE_TYPES.filter((t) => matchingHandle(link.from, nodes, t));
}

/**
 * Where a new node goes when a connection is dropped at `point`: its matching handle at the drop
 * point (data handles are on the sides, tool handles on the top and bottom).
 */
export function placementFor(link: NodeLink | undefined, nodes: CanvasNode[], type: NodeType, point: XYPosition): XYPosition {
  const centred = { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 };
  if (link?.kind !== "connect") return centred;
  const handle = matchingHandle(link.from, nodes, type);
  if (!handle) return centred;
  const after = link.from.handleType === "source"; // the new node comes after the handle
  if (handle.kind === "tool") {
    // After an agent's Tools handle (bottom) → below it, top handle at the point; else above.
    return { x: centred.x, y: after ? point.y : point.y - NODE_HEIGHT };
  }
  return { x: after ? point.x : point.x - NODE_WIDTH, y: centred.y };
}

/** Horizontal space kept on each side of a node inserted into an edge. */
export const INSERT_GAP = 80;

const widthOf = (n: CanvasNode) => n.measured?.width ?? NODE_WIDTH;
const heightOf = (n: CanvasNode) => n.measured?.height ?? NODE_HEIGHT;
const snap = (v: number) => Math.round(v / 10) * 10;

/**
 * Places node `nodeId`, just inserted between `sourceId` and `targetId`, between them — and when
 * they're too close for it, moves the target and everything after it (following edges, including
 * attached tools, but never the source or what runs before it) to the right to make room.
 * Backward edges (into a Loop) are left alone: the node keeps its position.
 */
export function makeRoomForInsert(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  nodeId: string,
  sourceId: string,
  targetId: string,
): CanvasNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const node = byId.get(nodeId);
  const source = byId.get(sourceId);
  const target = byId.get(targetId);
  if (!node || !source || !target || target.position.x <= source.position.x) return nodes;

  const left = source.position.x + widthOf(source) + INSERT_GAP;
  const shift = Math.max(0, left + widthOf(node) + INSERT_GAP - target.position.x);
  const middle = (source.position.y + heightOf(source) / 2 + target.position.y + heightOf(target) / 2) / 2;
  const position = { x: snap(left), y: snap(middle - heightOf(node) / 2) };

  const moved = new Set<string>();
  if (shift > 0) {
    // What runs before the source (and the source itself) stays put, even in a loop.
    const before = new Set([sourceId]);
    for (let queue = [sourceId]; queue.length; ) {
      const current = queue.shift()!;
      for (const e of edges) {
        if (e.target === current && !before.has(e.source)) {
          before.add(e.source);
          queue.push(e.source);
        }
      }
    }
    for (let queue = [targetId]; queue.length; ) {
      const current = queue.shift()!;
      if (moved.has(current) || before.has(current) || current === nodeId) continue;
      moved.add(current);
      queue.push(...edges.filter((e) => e.source === current).map((e) => e.target));
    }
  }
  return nodes.map((n) => {
    if (n.id === nodeId) return { ...n, position };
    if (moved.has(n.id)) return { ...n, position: { x: n.position.x + shift, y: n.position.y } };
    return n;
  });
}

/**
 * `edges` with node `nodeId` linked as `link` describes, or null when that's not possible (the
 * node doesn't fit, or a connection rule refuses it — e.g. a cycle without a Loop).
 */
export function linkEdges(
  link: NodeLink,
  nodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): CanvasEdge[] | null {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  if (link.kind === "connect") {
    const handle = matchingHandle(link.from, nodes, node.type);
    if (!handle) return null;
    const { from } = link;
    const conn =
      from.handleType === "source"
        ? { source: from.nodeId, sourceHandle: from.handleId, target: nodeId, targetHandle: handle.id }
        : { source: nodeId, sourceHandle: handle.id, target: from.nodeId, targetHandle: from.handleId };
    const check = checkConnection(conn, nodes, edges);
    return check.ok ? [...edges, createEdge(conn, check.type)] : null;
  }

  const edge = edges.find((e) => e.id === link.edgeId);
  if (!edge || (edge.type ?? "data") !== "data" || !canSplitWith(node.type)) return null;
  if (edge.source === nodeId || edge.target === nodeId) return null;
  const def = NODE_REGISTRY[node.type];
  const input = def.inputs.find((h) => h.kind === "data")!;
  const output = def.outputs.find((h) => h.kind === "data")!;
  const rest = edges.filter((e) => e.id !== edge.id);
  const first = { source: edge.source, sourceHandle: edge.sourceHandle ?? null, target: nodeId, targetHandle: input.id };
  const firstCheck = checkConnection(first, nodes, rest);
  if (!firstCheck.ok) return null;
  const withFirst = [...rest, createEdge(first, firstCheck.type)];
  const second = { source: nodeId, sourceHandle: output.id, target: edge.target, targetHandle: edge.targetHandle ?? null };
  const secondCheck = checkConnection(second, nodes, withFirst);
  if (!secondCheck.ok) return null;
  return [...withFirst, createEdge(second, secondCheck.type)];
}
