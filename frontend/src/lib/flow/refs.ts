/**
 * Node refs: the readable, unique names used in template references (`{{agent.output}}`).
 * Rules match the backend's Flow schema (backend/app/schemas/flow.py: REF_PATTERN, RESERVED_REFS).
 */
import { NODE_REGISTRY } from "@/lib/nodes/registry";
import type { NodeType } from "@/types/flow";

export const REF_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
/** `{{input.x}}` already means "the previous node's output". */
export const RESERVED_REFS = new Set(["input"]);

interface RefNode {
  id: string;
  type: NodeType;
  ref?: string;
}

/** A user-facing reason `ref` can't be used for node `nodeId`, or null if it's fine. */
export function refProblem(ref: string, nodeId: string, nodes: RefNode[]): string | null {
  if (!ref) return "Enter a name.";
  if (!REF_PATTERN.test(ref)) {
    return "Use lowercase letters, numbers and _, starting with a letter (max 40).";
  }
  if (RESERVED_REFS.has(ref)) return `“${ref}” is reserved.`;
  if (nodes.some((n) => n.id !== nodeId && (n.ref === ref || n.id === ref))) {
    return `Another node is already called “${ref}”.`;
  }
  return null;
}

/** `agent`, then `agent_2`, `agent_3`, … — the first name not used as a ref or id. */
export function uniqueRef(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(prefix)) return prefix;
  for (let i = 2; ; i++) {
    const candidate = `${prefix}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Gives every node a valid, unique ref, keeping existing valid ones (first wins on duplicates).
 * Used when loading flows saved before refs existed, or imported files with bad refs.
 */
export function normalizeRefs<T extends RefNode>(nodes: T[]): T[] {
  const ids = new Set(nodes.map((n) => n.id));
  // A ref may equal the node's *own* id; only other nodes' ids would make references ambiguous.
  const usable = (n: T): n is T & { ref: string } =>
    !!n.ref &&
    REF_PATTERN.test(n.ref) &&
    !RESERVED_REFS.has(n.ref) &&
    (n.ref === n.id || !ids.has(n.ref));

  // Pass 1: keep valid refs (the first node wins a duplicated one).
  const used = new Set<string>();
  const kept = nodes.map((n) => {
    if (!usable(n) || used.has(n.ref)) return false;
    used.add(n.ref);
    return true;
  });

  // Pass 2: give everything else the next free name for its type.
  return nodes.map((n, i) => {
    if (kept[i]) return n;
    const others = [...ids].filter((id) => id !== n.id);
    const ref = uniqueRef(NODE_REGISTRY[n.type].refPrefix, [...used, ...others]);
    used.add(ref);
    return { ...n, ref };
  });
}

/** The node a template reference points at: by ref, or by id for older flows. */
export function findReferencedNode<T extends RefNode>(name: string, nodes: T[]): T | undefined {
  return nodes.find((n) => n.ref === name) ?? nodes.find((n) => n.id === name);
}

interface GraphEdge {
  source: string;
  target: string;
  type?: string;
}

/**
 * Ids of the nodes whose output is available when `nodeId` runs: everything upstream along data
 * edges, nearest first. A tool runs inside the agent it's attached to, so it sees what that agent
 * sees (but not the agent's own output, which doesn't exist yet). Cycles (loops) are handled.
 */
export function upstreamNodeIds(nodeId: string, edges: GraphEdge[]): string[] {
  const isData = (e: GraphEdge) => (e.type ?? "data") === "data";
  const agents = edges.filter((e) => e.type === "tool_connection" && e.target === nodeId);
  const result: string[] = [];
  const seen = new Set<string>([nodeId]);
  const queue: string[] = [nodeId, ...agents.map((e) => e.source)];
  for (const a of agents) seen.add(a.source);
  while (queue.length) {
    const current = queue.shift()!;
    for (const e of edges) {
      if (isData(e) && e.target === current && !seen.has(e.source)) {
        seen.add(e.source);
        result.push(e.source);
        queue.push(e.source);
      }
    }
  }
  // In a loop the node is its own ancestor; never offer or allow a self-reference.
  return result.filter((id) => id !== nodeId);
}
