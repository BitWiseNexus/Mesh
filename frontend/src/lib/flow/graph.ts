/**
 * Pure graph helpers shared by the store and canvas: React Flow <-> Flow JSON conversion,
 * connection rules, and import parsing. No React or store state in here.
 */
import type { Connection, Edge, Node } from "@xyflow/react";

import { NODE_REGISTRY, type HandleDef } from "@/lib/nodes/registry";
import {
  EDGE_TYPES,
  NODE_TYPES,
  type EdgeType,
  type Flow,
  type FlowEdge,
  type FlowNode,
  type NodeData,
  type NodeType,
} from "@/types/flow";

import { normalizeRefs } from "./refs";

export type CanvasNode = Node<NodeData, NodeType> & { ref?: string };
export type CanvasEdge = Edge<Record<string, unknown>, EdgeType>;

export type FlowMeta = Pick<Flow, "flow_id" | "name" | "description">;

export const SCHEMA_VERSION = 1;

export const newId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

// ── Conversion ────────────────────────────────────────────────────────────

export function toFlow(meta: FlowMeta, nodes: CanvasNode[], edges: CanvasEdge[]): Flow {
  return {
    schema_version: SCHEMA_VERSION,
    ...meta,
    nodes: nodes.map(
      (n): FlowNode => ({
        id: n.id,
        type: n.type as NodeType,
        ref: n.ref,
        data: n.data,
        position: { x: n.position.x, y: n.position.y },
      }),
    ),
    edges: edges.map(
      (e): FlowEdge => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: (e.type ?? "data") as EdgeType,
        sourceHandle: e.sourceHandle ?? null,
        targetHandle: e.targetHandle ?? null,
        animated: e.animated ?? false,
      }),
    ),
  };
}

export function fromFlow(flow: Flow): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  return {
    // Every canvas node has a valid, unique ref and a value for every field its type defines
    // (older flows and imports may predate either).
    nodes: normalizeRefs(
      flow.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        ref: n.ref,
        data: withFieldDefaults(n.type, n.data),
        position: n.position,
      })),
    ),
    edges: flow.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.type,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
      animated: e.animated ?? false,
    })),
  };
}

/**
 * Fills in config fields a node type gained after the node was saved (e.g. an agent's Task) with
 * their defaults. Existing values, and keys the catalog doesn't know, are kept as they are.
 */
export function withFieldDefaults(type: NodeType, data: NodeData): NodeData {
  const def = NODE_REGISTRY[type];
  const missing = def.fields.filter((f) => !(f.key in data));
  if (missing.length === 0) return data;
  const filled: NodeData = { ...data };
  for (const f of missing) filled[f.key] = structuredClone(def.defaultData[f.key]);
  return filled;
}

// ── Connection rules ──────────────────────────────────────────────────────

type ConnectionLike = Pick<Connection, "source" | "target"> & {
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export type ConnectionCheck = { ok: true; type: EdgeType } | { ok: false; reason: string };

/** The handle an edge end attaches to (null id = the node's single/first handle). */
export function findHandle(
  node: Pick<CanvasNode, "type">,
  handleId: string | null | undefined,
  side: "source" | "target",
): HandleDef | undefined {
  const def = NODE_REGISTRY[node.type as NodeType];
  const handles = side === "source" ? def.outputs : def.inputs;
  // React Flow reports a null handle id when a node has a single unnamed handle.
  return handleId ? handles.find((h) => h.id === handleId) : handles[0];
}

/** Nodes reachable from `start` following data edges (forward or backward), including `start`. */
function reachable(start: string, edges: CanvasEdge[], direction: "forward" | "backward"): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift()!;
    for (const e of edges) {
      if ((e.type ?? "data") !== "data") continue;
      const [from, to] = direction === "forward" ? [e.source, e.target] : [e.target, e.source];
      if (from === current && !seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return seen;
}

/**
 * Decides whether a connection is allowed and which edge type it creates.
 * - handle kinds must match: data -> data, tool -> tool (= tool_connection)
 * - no self-connections or duplicate connections
 * - a data edge that closes a cycle is only allowed if the cycle passes through a Loop node
 */
export function checkConnection(
  conn: ConnectionLike,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): ConnectionCheck {
  const source = nodes.find((n) => n.id === conn.source);
  const target = nodes.find((n) => n.id === conn.target);
  if (!source || !target) return { ok: false, reason: "Unknown node" };
  if (source.id === target.id) return { ok: false, reason: "A node can't connect to itself" };

  const sourceHandle = findHandle(source, conn.sourceHandle, "source");
  const targetHandle = findHandle(target, conn.targetHandle, "target");
  if (!sourceHandle || !targetHandle) return { ok: false, reason: "Unknown handle" };
  if (sourceHandle.kind !== targetHandle.kind) {
    return {
      ok: false,
      reason:
        sourceHandle.kind === "tool"
          ? "An agent's Tools handle only connects to tools"
          : "Tools attach to an agent's Tools handle",
    };
  }

  const duplicate = edges.some(
    (e) =>
      e.source === source.id &&
      e.target === target.id &&
      (e.sourceHandle ?? null) === sourceHandle.id &&
      (e.targetHandle ?? null) === targetHandle.id,
  );
  if (duplicate) return { ok: false, reason: "These handles are already connected" };

  const type: EdgeType = sourceHandle.kind === "tool" ? "tool_connection" : "data";

  if (type === "data") {
    const downstreamOfTarget = reachable(target.id, edges, "forward");
    if (downstreamOfTarget.has(source.id)) {
      const upstreamOfSource = reachable(source.id, edges, "backward");
      const cycleNodes = [...downstreamOfTarget].filter((id) => upstreamOfSource.has(id));
      const hasLoop = cycleNodes.some((id) => nodes.find((n) => n.id === id)?.type === "logic_loop");
      if (!hasLoop) return { ok: false, reason: "Cycles must go through a Loop node" };
    }
  }

  return { ok: true, type };
}

/** Builds the edge for an accepted connection. */
export function createEdge(conn: ConnectionLike, type: EdgeType): CanvasEdge {
  return {
    id: newId("edge"),
    source: conn.source,
    target: conn.target,
    sourceHandle: conn.sourceHandle ?? null,
    targetHandle: conn.targetHandle ?? null,
    type,
    animated: false,
  };
}

// ── Import parsing ────────────────────────────────────────────────────────

export type ParseResult = { ok: true; flow: Flow } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parses and structurally validates Flow JSON (e.g. from an imported file). Mirrors the backend's
 * structural checks so bad files are caught before they reach the canvas.
 */
export function parseFlowJson(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "File is not valid JSON" };
  }
  if (!isObject(raw)) return { ok: false, error: "Flow must be a JSON object" };
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    return { ok: false, error: "Flow needs `nodes` and `edges` arrays" };
  }

  const nodes: FlowNode[] = [];
  for (const [i, n] of raw.nodes.entries()) {
    if (!isObject(n) || typeof n.id !== "string" || !n.id) {
      return { ok: false, error: `Node #${i + 1} has no id` };
    }
    if (!NODE_TYPES.includes(n.type as NodeType)) {
      return { ok: false, error: `Node "${n.id}" has unknown type "${String(n.type)}"` };
    }
    const pos = n.position;
    if (!isObject(pos) || typeof pos.x !== "number" || typeof pos.y !== "number") {
      return { ok: false, error: `Node "${n.id}" has an invalid position` };
    }
    nodes.push({
      id: n.id,
      type: n.type as NodeType,
      ref: typeof n.ref === "string" ? n.ref : undefined, // repaired by normalizeRefs on load
      data: isObject(n.data) ? (n.data as NodeData) : {},
      position: { x: pos.x, y: pos.y },
    });
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  if (nodeIds.size !== nodes.length) return { ok: false, error: "Duplicate node ids" };

  const edges: FlowEdge[] = [];
  for (const [i, e] of raw.edges.entries()) {
    if (!isObject(e) || typeof e.id !== "string" || !e.id) {
      return { ok: false, error: `Edge #${i + 1} has no id` };
    }
    if (typeof e.source !== "string" || typeof e.target !== "string") {
      return { ok: false, error: `Edge "${e.id}" needs a source and target` };
    }
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) {
      return { ok: false, error: `Edge "${e.id}" points to a missing node` };
    }
    const type = e.type == null || e.type === "" || e.type === "default" ? "data" : e.type;
    if (!EDGE_TYPES.includes(type as EdgeType)) {
      return { ok: false, error: `Edge "${e.id}" has unknown type "${String(e.type)}"` };
    }
    edges.push({
      id: e.id,
      source: e.source,
      target: e.target,
      type: type as EdgeType,
      sourceHandle: typeof e.sourceHandle === "string" ? e.sourceHandle : null,
      targetHandle: typeof e.targetHandle === "string" ? e.targetHandle : null,
      animated: e.animated === true,
    });
  }
  if (new Set(edges.map((e) => e.id)).size !== edges.length) {
    return { ok: false, error: "Duplicate edge ids" };
  }

  return {
    ok: true,
    flow: {
      schema_version: SCHEMA_VERSION,
      flow_id: typeof raw.flow_id === "string" ? raw.flow_id : null,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name : "Imported flow",
      description: typeof raw.description === "string" ? raw.description : "",
      nodes,
      edges,
    },
  };
}
