import { describe, expect, it } from "vitest";

import type { NodeType } from "@/types/flow";

import {
  ADDABLE_TYPES,
  canSplitWith,
  INSERT_GAP,
  linkEdges,
  makeRoomForInsert,
  pickableTypes,
  placementFor,
  type NodeLink,
} from "./connect";
import { NODE_HEIGHT, NODE_WIDTH, type CanvasEdge, type CanvasNode } from "./graph";

const node = (id: string, type: NodeType): CanvasNode => ({ id, type, data: {}, position: { x: 0, y: 0 } });
const edge = (id: string, source: string, target: string, sourceHandle = "out", targetHandle = "in"): CanvasEdge => ({
  id,
  source,
  target,
  sourceHandle,
  targetHandle,
  type: sourceHandle === "tools" ? "tool_connection" : "data",
});

const nodes = [
  node("t", "trigger_manual"),
  node("a", "agent_node"),
  node("o", "output_display"),
  node("s", "tool_web_search"),
  node("n", "logic_if"), // the new node in the tests below
];
const edges = [edge("e1", "t", "a"), edge("e2", "a", "o")];

const connect = (nodeId: string, handleId: string, handleType: "source" | "target"): NodeLink => ({
  kind: "connect",
  from: { nodeId, handleId, handleType },
});

describe("pickableTypes", () => {
  it("offers only addable types that fit the dragged handle", () => {
    expect(ADDABLE_TYPES).not.toContain("tool_python"); // "Soon"
    expect(ADDABLE_TYPES).toContain("kb_retriever");
    expect(ADDABLE_TYPES).not.toContain("kb_notion"); // retired
    expect(pickableTypes(undefined, nodes)).toEqual(ADDABLE_TYPES);

    // After an output: anything with a data input — no triggers, no tools.
    const after = pickableTypes(connect("a", "out", "source"), nodes);
    expect(after).toContain("output_display");
    expect(after).not.toContain("trigger_manual");
    expect(after).not.toContain("tool_web_search");
    // Before an input: anything with a data output — triggers yes, Output no.
    const before = pickableTypes(connect("a", "in", "target"), nodes);
    expect(before).toContain("trigger_manual");
    expect(before).not.toContain("output_display");
    // An agent's Tools handle: tools, agents and the Retriever (they can be tools).
    expect(pickableTypes(connect("a", "tools", "source"), nodes)).toEqual([
      "agent_node",
      "tool_web_search",
      "tool_web_scraper",
      "tool_http",
      "kb_retriever",
    ]);
    // A tool's handle, dragged backwards: the agents that can use it.
    expect(pickableTypes(connect("s", "tool", "target"), nodes)).toEqual(["agent_node"]);
    // Into an edge: one data input and one data output.
    const split = pickableTypes({ kind: "split", edgeId: "e1" }, nodes);
    expect(split).toContain("agent_node");
    expect(split.every(canSplitWith)).toBe(true);
    expect(split).not.toContain("output_display");
  });
});

describe("placementFor", () => {
  const p = { x: 1000, y: 500 };
  it("puts the new node's matching handle at the drop point", () => {
    expect(placementFor(connect("a", "out", "source"), nodes, "agent_node", p)).toEqual({
      x: 1000,
      y: 500 - NODE_HEIGHT / 2,
    });
    expect(placementFor(connect("a", "in", "target"), nodes, "agent_node", p)).toEqual({
      x: 1000 - NODE_WIDTH,
      y: 500 - NODE_HEIGHT / 2,
    });
    expect(placementFor(connect("a", "tools", "source"), nodes, "tool_http", p)).toEqual({
      x: 1000 - NODE_WIDTH / 2,
      y: 500,
    });
    expect(placementFor(connect("s", "tool", "target"), nodes, "agent_node", p)).toEqual({
      x: 1000 - NODE_WIDTH / 2,
      y: 500 - NODE_HEIGHT,
    });
    expect(placementFor(undefined, nodes, "agent_node", p)).toEqual({
      x: 1000 - NODE_WIDTH / 2,
      y: 500 - NODE_HEIGHT / 2,
    });
  });
});

describe("linkEdges", () => {
  it("connects a new node to the dragged handle, in either direction", () => {
    const after = linkEdges(connect("a", "out", "source"), "n", nodes, edges)!;
    expect(after.at(-1)).toMatchObject({ source: "a", sourceHandle: "out", target: "n", targetHandle: "in", type: "data" });
    const before = linkEdges(connect("a", "in", "target"), "n", nodes, edges)!;
    expect(before.at(-1)).toMatchObject({ source: "n", sourceHandle: "true", target: "a", targetHandle: "in" });
    const tool = linkEdges(connect("a", "tools", "source"), "s", nodes, edges)!;
    expect(tool.at(-1)).toMatchObject({ source: "a", target: "s", targetHandle: "tool", type: "tool_connection" });
  });

  it("refuses links that don't fit or break a rule", () => {
    expect(linkEdges(connect("a", "tools", "source"), "o", nodes, edges)).toBeNull(); // Output isn't a tool
    expect(linkEdges(connect("o", "in", "target"), "t", nodes, [])).not.toBeNull(); // trigger → Output
    expect(linkEdges(connect("t", "in", "target"), "a", nodes, edges)).toBeNull(); // triggers have no input
    expect(linkEdges(connect("t", "out", "source"), "a", nodes, edges)).toBeNull(); // already connected
    // n already follows a: putting it before a too would close a cycle without a Loop.
    const cyclic = [...edges, edge("e3", "a", "n")];
    expect(linkEdges(connect("a", "in", "target"), "n", nodes, cyclic)).toBeNull();
  });

  it("inserts a node into a data edge: A → B becomes A → node → B", () => {
    const split = linkEdges({ kind: "split", edgeId: "e2" }, "n", nodes, edges)!;
    expect(split.map((e) => [e.source, e.sourceHandle, e.target, e.targetHandle])).toEqual([
      ["t", "out", "a", "in"],
      ["a", "out", "n", "in"],
      ["n", "true", "o", "in"], // the first data output (If's "true")
    ]);
    // Not into tool edges, not with nodes lacking an input or output, not into its own edge.
    const withTool = [...edges, edge("e3", "a", "s", "tools", "tool")];
    expect(linkEdges({ kind: "split", edgeId: "e3" }, "n", nodes, withTool)).toBeNull();
    expect(linkEdges({ kind: "split", edgeId: "e2" }, "o", nodes, edges)).toBeNull();
    expect(linkEdges({ kind: "split", edgeId: "e2" }, "a", nodes, edges)).toBeNull();
    expect(linkEdges({ kind: "split", edgeId: "missing" }, "n", nodes, edges)).toBeNull();
  });
});

describe("makeRoomForInsert", () => {
  const at = (n: CanvasNode, x: number, y = 0): CanvasNode => ({ ...n, position: { x, y } });
  // t (0) → a (400) → o (800), a's tool s below it; n inserted into t → a.
  const laidOut = [at(nodes[0], 0), at(nodes[1], 400), at(nodes[2], 800), at(nodes[3], 400, 200), at(nodes[4], 0, 500)];
  const split = [edge("x1", "t", "n"), edge("x2", "n", "a"), edge("e2", "a", "o"), edge("e3", "a", "s", "tools", "tool")];

  it("puts the node between the ends and pushes what follows to the right when needed", () => {
    const result = makeRoomForInsert(laidOut, split, "n", "t", "a");
    const x = Object.fromEntries(result.map((n) => [n.id, n.position.x]));
    const shift = NODE_WIDTH + INSERT_GAP + NODE_WIDTH + INSERT_GAP - 400; // room needed − room there
    expect(x).toEqual({ t: 0, n: NODE_WIDTH + INSERT_GAP, a: 400 + shift, o: 800 + shift, s: 400 + shift });
    expect(result.find((n) => n.id === "n")!.position.y).toBe(0); // level with the ends
  });

  it("moves nothing else when there's room, and leaves backward edges alone", () => {
    const wide = laidOut.map((n) => (n.id === "a" ? at(n, 1000) : n.id === "o" ? at(n, 1400) : n));
    const result = makeRoomForInsert(wide, split, "n", "t", "a");
    expect(result.filter((n) => n.id !== "n")).toEqual(wide.filter((n) => n.id !== "n"));
    expect(makeRoomForInsert(laidOut, split, "n", "a", "t")).toBe(laidOut);
  });
});
