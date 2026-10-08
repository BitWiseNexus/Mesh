import type { Flow } from "@/types/flow";

/** JSON with object keys sorted at every level, so equal values always serialise identically. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * Identifies a flow's *saved content* (name, description, graph): two flows with the same
 * fingerprint save to the same thing. Ignores ids, versions and UI-only state.
 */
export function contentFingerprint(flow: Pick<Flow, "name" | "description" | "nodes" | "edges">): string {
  return stableStringify({
    name: flow.name,
    description: flow.description,
    nodes: flow.nodes,
    edges: flow.edges,
  });
}
