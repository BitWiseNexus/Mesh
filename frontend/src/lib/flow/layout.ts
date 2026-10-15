/**
 * Auto-layout ("Tidy up"): a layered left-to-right layout of the data flow (dagre), with the tools
 * attached to an agent laid out as a row underneath it (tool handles are on the bottom of agents
 * and the top of tools). Pure apart from loading dagre on first use (kept out of the editor's
 * bundle until someone tidies up).
 */
import type { XYPosition } from "@xyflow/react";

import { NODE_REGISTRY } from "@/lib/nodes/registry";

import { NODE_HEIGHT, NODE_WIDTH, type CanvasEdge, type CanvasNode } from "./graph";

/** Horizontal gap between layers (columns) and vertical gap between nodes in one layer. */
export const LAYER_GAP = 120;
export const NODE_GAP = 60;
/** Gaps between an agent and its row of tools, and between the tools in that row. */
export const TOOL_ROW_GAP = 80;
export const TOOL_GAP = 40;

const widthOf = (n: CanvasNode) => n.measured?.width ?? NODE_WIDTH;
const heightOf = (n: CanvasNode) => n.measured?.height ?? NODE_HEIGHT;
const isData = (e: CanvasEdge) => (e.type ?? "data") === "data";
const snap = (v: number) => Math.round(v / 10) * 10;

/** A node and the tools attached to it (recursively), with their sizes. */
interface Block {
  node: CanvasNode;
  tools: Block[];
  width: number;
  /** From the node's top edge to the bottom of its tools. */
  height: number;
}

/**
 * Nodes attached as tools (tool edge in, no data edges) belong to the first agent that attaches
 * them; everything else is laid out by dagre.
 */
function buildBlocks(nodes: CanvasNode[], edges: CanvasEdge[]): Block[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hasData = new Set(edges.filter(isData).flatMap((e) => [e.source, e.target]));
  const owner = new Map<string, string>();
  for (const e of edges) {
    if (isData(e) || owner.has(e.target) || hasData.has(e.target) || !byId.has(e.source)) continue;
    owner.set(e.target, e.source);
  }

  const placed = new Set<string>(); // guards against tool cycles (a validation error, but possible)
  const block = (node: CanvasNode): Block => {
    placed.add(node.id);
    const tools = edges
      .filter((e) => !isData(e) && e.source === node.id && owner.get(e.target) === node.id)
      .map((e) => byId.get(e.target)!)
      .filter((t) => !placed.has(t.id))
      .map(block);
    const rowWidth = tools.reduce((w, t) => w + t.width, 0) + TOOL_GAP * Math.max(0, tools.length - 1);
    const rowHeight = Math.max(0, ...tools.map((t) => t.height));
    return {
      node,
      tools,
      width: Math.max(widthOf(node), rowWidth),
      height: heightOf(node) + (tools.length ? TOOL_ROW_GAP + rowHeight : 0),
    };
  };
  // Roots in canvas order; tools whose owner chain loops back are roots too.
  const roots = nodes.filter((n) => !owner.has(n.id)).map(block);
  const stragglers = nodes.filter((n) => !placed.has(n.id)).map(block);
  return [...roots, ...stragglers];
}

/** Places a block's node at `center.x`, top edge `top`, and its tools in a centred row below. */
function placeBlock(block: Block, centerX: number, top: number, into: Map<string, XYPosition>) {
  into.set(block.node.id, { x: centerX - widthOf(block.node) / 2, y: top });
  if (!block.tools.length) return;
  const rowWidth =
    block.tools.reduce((w, t) => w + t.width, 0) + TOOL_GAP * (block.tools.length - 1);
  let left = centerX - rowWidth / 2;
  const rowTop = top + heightOf(block.node) + TOOL_ROW_GAP;
  for (const tool of block.tools) {
    placeBlock(tool, left + tool.width / 2, rowTop, into);
    left += tool.width + TOOL_GAP;
  }
}

/**
 * Data edges that close a cycle (a Loop's body going back into it), found by a depth-first walk
 * from the triggers (then from the other nodes, in canvas order). Leaving them out of the layering
 * keeps a loop's body after the Loop instead of before it.
 */
export function backEdges(nodes: CanvasNode[], edges: CanvasEdge[]): Set<string> {
  const data = edges.filter(isData);
  const out = new Map<string, CanvasEdge[]>();
  for (const e of data) out.set(e.source, [...(out.get(e.source) ?? []), e]);
  const state = new Map<string, "active" | "done">();
  const back = new Set<string>();
  const visit = (id: string) => {
    state.set(id, "active");
    for (const e of out.get(id) ?? []) {
      const next = state.get(e.target);
      if (next === "active") back.add(e.id);
      else if (!next) visit(e.target);
    }
    state.set(id, "done");
  };
  const triggersFirst = [
    ...nodes.filter((n) => n.type.startsWith("trigger_")),
    ...nodes.filter((n) => !n.type.startsWith("trigger_")),
  ];
  for (const n of triggersFirst) if (!state.has(n.id)) visit(n.id);
  return back;
}

/**
 * Keeps a branching node's targets in the order of its outputs, top to bottom (If's true above
 * false, Loop's loop above done) so their edges don't cross. dagre ignores pairs in different
 * layers; in a left-to-right layout its "left" is the upper one.
 */
function branchOrder(nodes: CanvasNode[], edges: CanvasEdge[]) {
  const constraints: { left: string; right: string }[] = [];
  for (const node of nodes) {
    const outputs = NODE_REGISTRY[node.type].outputs.filter((h) => h.kind === "data");
    if (outputs.length < 2) continue;
    const rank = (e: CanvasEdge) => Math.max(0, outputs.findIndex((h) => h.id === e.sourceHandle));
    const targets = [
      ...new Set(
        edges
          .filter((e) => e.source === node.id)
          .sort((a, b) => rank(a) - rank(b))
          .map((e) => e.target),
      ),
    ];
    for (let i = 1; i < targets.length; i++) {
      constraints.push({ left: targets[i - 1], right: targets[i] });
    }
  }
  return constraints;
}

/**
 * New positions (top-left corners) for every node: a tidy left-to-right layout, moved so its
 * top-left corner is where the flow's was (the flow stays roughly where the user was looking).
 */
export async function computeLayout(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): Promise<Map<string, XYPosition>> {
  const positions = new Map<string, XYPosition>();
  if (nodes.length === 0) return positions;
  const { default: dagre } = await import("@dagrejs/dagre");

  const blocks = buildBlocks(nodes, edges);
  const blockOf = new Map(blocks.map((b) => [b.node.id, b]));
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", ranksep: LAYER_GAP, nodesep: NODE_GAP, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const b of blocks) {
    // The space reserved is centred on the node itself (tools below it, the same room left free
    // above): dagre aligns centres, so connected nodes line up and their edges run straight.
    const below = b.height - heightOf(b.node);
    graph.setNode(b.node.id, { width: b.width, height: heightOf(b.node) + 2 * below });
  }
  const back = backEdges(nodes, edges);
  const layered = edges.filter(
    (e) => isData(e) && !back.has(e.id) && blockOf.has(e.source) && blockOf.has(e.target),
  );
  for (const e of layered) graph.setEdge(e.source, e.target);
  dagre.layout(graph, { constraints: branchOrder(nodes, layered) });

  for (const b of blocks) {
    const { x, y } = graph.node(b.node.id);
    placeBlock(b, x!, y! - heightOf(b.node) / 2, positions);
  }

  // Keep the flow where it was: same top-left corner as before.
  const minOf = (values: number[]) => Math.min(...values);
  const dx = minOf(nodes.map((n) => n.position.x)) - minOf([...positions.values()].map((p) => p.x));
  const dy = minOf(nodes.map((n) => n.position.y)) - minOf([...positions.values()].map((p) => p.y));
  for (const [id, p] of positions) positions.set(id, { x: snap(p.x + dx), y: snap(p.y + dy) });
  return positions;
}
