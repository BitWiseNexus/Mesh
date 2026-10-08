/**
 * Template references in node config, e.g. "Summarise: {{agent.output.summary}}".
 *
 * Grammar (must match backend/app/engine/templates.py; both are tested against
 * shared/template-cases.json):
 *   {{input}} | {{input.<path>}}         output of the previous node (multi-input rules: see R3)
 *   {{<node>.output}} | {{<node>.output.<path>}}
 *     <node> = a node's ref (e.g. agent_2) or, for older flows, its id (node_8203befa)
 *     <path> = segments of [A-Za-z0-9_]+ separated by "."; numeric segments index lists
 * Anything else between {{ and }} is an invalid reference. Whitespace inside the braces is ignored.
 */

export type TemplatePart =
  | { kind: "text"; value: string }
  | { kind: "ref"; node: string; path: string[] }
  | { kind: "input"; path: string[] }
  | { kind: "invalid"; raw: string };

const TOKEN = /\{\{([^{}]*)\}\}/g;
const NODE = /^[a-z][a-z0-9_]*$/;
const SEGMENT = /^[A-Za-z0-9_]+$/;

type ReferencePart = Extract<TemplatePart, { kind: "ref" | "input" }>;

function parseToken(inner: string): ReferencePart | null {
  const segments = inner.trim().split(".");
  if (segments.some((s) => s === "")) return null;
  if (segments[0] === "input") {
    const path = segments.slice(1);
    return path.every((s) => SEGMENT.test(s)) ? { kind: "input", path } : null;
  }
  const [node, keyword, ...path] = segments;
  if (!NODE.test(node) || keyword !== "output" || !path.every((s) => SEGMENT.test(s))) return null;
  return { kind: "ref", node, path };
}

export function parseTemplate(text: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index!;
    if (index > last) parts.push({ kind: "text", value: text.slice(last, index) });
    parts.push(parseToken(match[1]) ?? { kind: "invalid", raw: match[0] });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  return parts;
}

export function formatReference(node: string, path: string[] = []): string {
  return `{{${[node, "output", ...path].join(".")}}}`;
}

export function formatInput(path: string[] = []): string {
  return `{{${["input", ...path].join(".")}}}`;
}

/** Node refs/ids referenced by `text` (deduplicated, in order of appearance). */
export function referencedNodes(text: string): string[] {
  const nodes = parseTemplate(text).flatMap((p) => (p.kind === "ref" ? [p.node] : []));
  return [...new Set(nodes)];
}

/** Rewrites references to node `from` so they point at `to`; everything else is kept verbatim. */
export function renameReferences(text: string, from: string, to: string): string {
  return text.replace(TOKEN, (raw, inner: string) => {
    const part = parseToken(inner);
    return part?.kind === "ref" && part.node === from ? formatReference(to, part.path) : raw;
  });
}
