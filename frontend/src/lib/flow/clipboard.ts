/**
 * Copy / paste / duplicate of nodes. Pure: the editor moves the text through the system clipboard
 * (so copies travel between tabs and flows) and applies the result through the flow store.
 *
 * A copy holds the chosen nodes and the edges *between* them (edges to nodes left behind are
 * dropped). Pasting gives every node a fresh id; a node keeps its ref when that name is still free
 * in the target flow (so references survive a paste into another flow), otherwise it gets a
 * numbered one (`agent_2` → `agent_3`). References between pasted nodes — by old ref or old id —
 * are rewritten to the new refs; references to nodes that weren't copied stay as they are.
 */
import type { XYPosition } from "@xyflow/react";

import { NODE_REGISTRY } from "@/lib/nodes/registry";
import type { FlowEdge, FlowNode } from "@/types/flow";

import {
  newId,
  NODE_HEIGHT,
  NODE_WIDTH,
  parseFlowJson,
  toFlow,
  withFieldDefaults,
  type CanvasEdge,
  type CanvasNode,
} from "./graph";
import { rewriteReferences } from "./references";
import { copyRef, REF_PATTERN, RESERVED_REFS, uniqueRef } from "./refs";

/** Marks clipboard text as Mesh nodes. */
export const CLIPBOARD_KIND = "mesh/nodes";

export interface NodeClipboard {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** Where pasted nodes go: their top-left corner at `topLeft`, or their middle at `center`. */
export type PasteTarget = { topLeft: XYPosition } | { center: XYPosition };

/** The nodes with ids in `ids` and the edges between them, or null when there are none. */
export function copyNodes(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  ids: ReadonlySet<string>,
): NodeClipboard | null {
  const picked = nodes.filter((n) => ids.has(n.id));
  if (picked.length === 0) return null;
  const between = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const { nodes: wireNodes, edges: wireEdges } = toFlow(
    { flow_id: null, name: "", description: "" },
    picked,
    between,
  );
  return { nodes: wireNodes, edges: wireEdges };
}

export function serializeClipboard(clipboard: NodeClipboard): string {
  return JSON.stringify({ kind: CLIPBOARD_KIND, version: 1, ...clipboard });
}

/**
 * Nodes in clipboard text: a Mesh copy, or a whole exported flow (`*.mesh.json` contents). Anything
 * else — including JSON that isn't a valid flow — is null, so pasting ordinary text does nothing.
 */
export function parseClipboard(text: string): NodeClipboard | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const marked = (raw as { kind?: unknown }).kind === CLIPBOARD_KIND || "schema_version" in raw;
  if (!marked) return null;
  const result = parseFlowJson(text);
  if (!result.ok || result.flow.nodes.length === 0) return null;
  return { nodes: result.flow.nodes, edges: result.flow.edges };
}

/** Bounding box of nodes (cards of the usual size at their positions). */
export function nodeBounds(nodes: { position: XYPosition }[]) {
  const xs = nodes.map((n) => n.position.x);
  const ys = nodes.map((n) => n.position.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) + NODE_WIDTH - x, height: Math.max(...ys) + NODE_HEIGHT - y };
}

const usableRef = (ref: string | undefined): ref is string =>
  !!ref && REF_PATTERN.test(ref) && !RESERVED_REFS.has(ref);

/**
 * Canvas nodes and edges for pasting `clipboard` into a flow that holds `existing`: fresh ids,
 * free refs, references between them rewritten, moved to `target`, and selected.
 */
export function pasteNodes(
  clipboard: NodeClipboard,
  existing: CanvasNode[],
  target: PasteTarget,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const ids = new Map(clipboard.nodes.map((n) => [n.id, newId("node")]));
  const taken = new Set([...existing.flatMap((n) => [n.id, n.ref ?? ""]), ...ids.values()]);

  // Refs: first every node whose own ref is still free keeps it, then the others get new ones.
  const refs = new Map<string, string>();
  for (const n of clipboard.nodes) {
    if (usableRef(n.ref) && !taken.has(n.ref)) {
      refs.set(n.id, n.ref);
      taken.add(n.ref);
    }
  }
  for (const n of clipboard.nodes) {
    if (refs.has(n.id)) continue;
    const ref = usableRef(n.ref)
      ? copyRef(n.ref, taken)
      : uniqueRef(NODE_REGISTRY[n.type].refPrefix, taken);
    refs.set(n.id, ref);
    taken.add(ref);
  }

  // Old names → new refs. Ids first, so a ref wins when it equals another node's id (as in
  // findReferencedNode).
  const renames = new Map<string, string>();
  for (const n of clipboard.nodes) renames.set(n.id, refs.get(n.id)!);
  for (const n of clipboard.nodes) if (n.ref) renames.set(n.ref, refs.get(n.id)!);

  const box = nodeBounds(clipboard.nodes);
  const origin =
    "topLeft" in target
      ? target.topLeft
      : { x: target.center.x - box.width / 2, y: target.center.y - box.height / 2 };
  const dx = origin.x - box.x;
  const dy = origin.y - box.y;

  const nodes = clipboard.nodes.map((n): CanvasNode => {
    let data = withFieldDefaults(n.type, structuredClone(n.data));
    for (const field of NODE_REGISTRY[n.type].fields) {
      const value = data[field.key];
      if (!field.templated || typeof value !== "string") continue;
      const next = rewriteReferences(value, renames);
      if (next !== value) data = { ...data, [field.key]: next };
    }
    return {
      id: ids.get(n.id)!,
      type: n.type,
      ref: refs.get(n.id),
      position: { x: Math.round(n.position.x + dx), y: Math.round(n.position.y + dy) },
      data,
      selected: true,
    };
  });
  const edges = clipboard.edges.map(
    (e): CanvasEdge => ({
      id: newId("edge"),
      source: ids.get(e.source)!,
      target: ids.get(e.target)!,
      type: e.type,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
      animated: false,
    }),
  );
  return { nodes, edges };
}
