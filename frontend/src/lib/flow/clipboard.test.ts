import { describe, expect, it } from "vitest";

import { createDefaultData } from "@/lib/nodes/registry";
import type { NodeType } from "@/types/flow";

import {
  CLIPBOARD_KIND,
  copyNodes,
  parseClipboard,
  pasteNodes,
  serializeClipboard,
  type NodeClipboard,
} from "./clipboard";
import type { CanvasEdge, CanvasNode } from "./graph";
import { copyRef, uniqueRef } from "./refs";
import { validateFlow } from "./validate";

const node = (
  id: string,
  type: NodeType,
  ref: string,
  data: Record<string, unknown> = {},
  position = { x: 0, y: 0 },
): CanvasNode => ({ id, type, ref, data: { ...createDefaultData(type), ...data }, position });

const edge = (source: string, target: string, sourceHandle = "out", targetHandle = "in"): CanvasEdge => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle,
  targetHandle,
  type: sourceHandle === "tools" ? "tool_connection" : "data",
});

// Trigger → Agent (Task uses the trigger) → Writer (Task uses the agent); Agent's tool: Search.
const flow = {
  nodes: [
    node("t", "trigger_manual", "trigger", {}, { x: 0, y: 0 }),
    node("a", "agent_node", "agent", { prompt: "Sort {{trigger.output}}" }, { x: 300, y: 0 }),
    node("w", "agent_node", "writer", { prompt: "Write {{agent.output.title}} / {{ a.output }}" }, { x: 600, y: 0 }),
    node("s", "tool_web_search", "web_search", {}, { x: 300, y: 200 }),
  ],
  edges: [edge("t", "a"), edge("a", "w"), edge("a", "s", "tools", "tool")],
};

const roundTrip = (clipboard: NodeClipboard) => parseClipboard(serializeClipboard(clipboard))!;

describe("copyNodes", () => {
  it("copies the chosen nodes and only the edges between them", () => {
    const copied = copyNodes(flow.nodes, flow.edges, new Set(["a", "w", "s"]))!;
    expect(copied.nodes.map((n) => n.id)).toEqual(["a", "w", "s"]);
    expect(copied.edges.map((e) => e.id)).toEqual(["a-w", "a-s"]); // t → a is left behind
    expect(copyNodes(flow.nodes, flow.edges, new Set())).toBeNull();
  });
});

describe("parseClipboard", () => {
  it("reads Mesh copies and exported flows, ignoring other text", () => {
    const copied = copyNodes(flow.nodes, flow.edges, new Set(["a"]))!;
    expect(roundTrip(copied).nodes).toHaveLength(1);
    const exported = JSON.stringify({ schema_version: 1, name: "x", nodes: copied.nodes, edges: [] });
    expect(parseClipboard(exported)?.nodes).toHaveLength(1);

    expect(parseClipboard("hello")).toBeNull();
    expect(parseClipboard(JSON.stringify({ nodes: copied.nodes, edges: [] }))).toBeNull(); // unmarked
    expect(parseClipboard(JSON.stringify({ kind: CLIPBOARD_KIND, nodes: [], edges: [] }))).toBeNull();
    const broken = { kind: CLIPBOARD_KIND, nodes: [{ id: "x", type: "nope", position: { x: 0, y: 0 } }], edges: [] };
    expect(parseClipboard(JSON.stringify(broken))).toBeNull();
  });
});

describe("pasteNodes", () => {
  it("gives copies fresh ids and refs, keeps their edges and rewrites references between them", () => {
    const copied = roundTrip(copyNodes(flow.nodes, flow.edges, new Set(["a", "w", "s"]))!);
    const { nodes, edges } = pasteNodes(copied, flow.nodes, { topLeft: { x: 1000, y: 500 } });

    expect(nodes.every((n) => !flow.nodes.some((o) => o.id === n.id))).toBe(true);
    expect(nodes.map((n) => n.ref)).toEqual(["agent_2", "writer_2", "web_search_2"]);
    expect(nodes.map((n) => n.position)).toEqual([
      { x: 1000, y: 500 },
      { x: 1300, y: 500 },
      { x: 1000, y: 700 },
    ]);
    expect(nodes.every((n) => n.selected)).toBe(true);
    // References to copied nodes (by ref or by id) follow the copies; others stay.
    expect(nodes[0].data.prompt).toBe("Sort {{trigger.output}}");
    expect(nodes[1].data.prompt).toBe("Write {{agent_2.output.title}} / {{agent_2.output}}");

    const [aw, as] = edges;
    expect([aw.source, aw.target]).toEqual([nodes[0].id, nodes[1].id]);
    expect([as.source, as.target, as.type]).toEqual([nodes[0].id, nodes[2].id, "tool_connection"]);
    expect(new Set(edges.map((e) => e.id)).size).toBe(2);
    expect(edges.some((e) => flow.edges.some((o) => o.id === e.id))).toBe(false);

    // Refs stay unique and references between the copies resolve; the only error is the copy's
    // reference to the trigger, which wasn't copied and doesn't run before it.
    const issues = validateFlow([...flow.nodes, ...nodes], [...flow.edges, ...edges]);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.map((i) => [i.nodeId, i.field])).toEqual([[nodes[0].id, "prompt"]]);
  });

  it("keeps refs that are free in the target flow, even when they swap names", () => {
    // Copy `agent` and `agent_2` (each referencing the other) into a flow that has neither.
    const source = [
      node("x", "agent_node", "agent_2", { prompt: "{{agent.output}}" }),
      node("y", "agent_node", "agent", { prompt: "{{agent_2.output}}" }),
    ];
    const copied = roundTrip(copyNodes(source, [], new Set(["x", "y"]))!);
    const empty = pasteNodes(copied, [], { topLeft: { x: 0, y: 0 } }).nodes;
    expect(empty.map((n) => [n.ref, n.data.prompt])).toEqual([
      ["agent_2", "{{agent.output}}"],
      ["agent", "{{agent_2.output}}"],
    ]);

    // Into a flow where only `agent` is taken: x keeps agent_2, y becomes agent_3 — and x's
    // reference to y follows it, in one pass (renaming one at a time would mangle the swap).
    const target = [node("z", "agent_node", "agent")];
    const pasted = pasteNodes(copied, target, { topLeft: { x: 0, y: 0 } }).nodes;
    expect(pasted.map((n) => [n.ref, n.data.prompt])).toEqual([
      ["agent_2", "{{agent_3.output}}"],
      ["agent_3", "{{agent_2.output}}"],
    ]);
  });

  it("centres on a point, repairs missing refs and fills in missing fields", () => {
    const copied: NodeClipboard = {
      nodes: [
        { id: "p", type: "agent_node", data: {}, position: { x: 0, y: 0 } },
        { id: "q", type: "agent_node", ref: "Bad Ref", data: {}, position: { x: 260, y: 40 } },
      ],
      edges: [],
    };
    const { nodes } = pasteNodes(copied, [], { center: { x: 250, y: 50 } });
    expect(nodes.map((n) => n.ref)).toEqual(["agent", "agent_2"]);
    // Bounds 500 × 100 (cards are 240 × 60) centred on (250, 50).
    expect(nodes.map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: 260, y: 40 },
    ]);
    expect(nodes[0].data).toMatchObject({ prompt: "{{input}}", temperature: 0.7 });
  });

  it("doesn't share data with the copied nodes", () => {
    const source = [node("x", "tool_http", "api", { headers: { a: "1" } })];
    const clipboard = copyNodes(source, [], new Set(["x"]))!; // not round-tripped through text
    const [copy] = pasteNodes(clipboard, source, { topLeft: { x: 0, y: 0 } }).nodes;
    (copy.data.headers as Record<string, string>).a = "2";
    expect(source[0].data.headers).toEqual({ a: "1" });
  });
});

describe("ref helpers", () => {
  it("numbers copies from the name without its number", () => {
    expect(copyRef("agent_2", ["agent", "agent_2"])).toBe("agent_3");
    expect(copyRef("summary", ["summary"])).toBe("summary_2");
    expect(copyRef("summary", [])).toBe("summary");
  });

  it("never returns a reserved name and keeps refs within 40 characters", () => {
    expect(copyRef("input_2", ["input_2"])).toBe("input_3");
    expect(uniqueRef("input", [])).toBe("input_2");
    const long = "a".repeat(40);
    expect(uniqueRef(long, [long])).toBe(`${"a".repeat(38)}_2`);
  });
});
