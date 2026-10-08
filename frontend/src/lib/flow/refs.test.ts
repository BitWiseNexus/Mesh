import { describe, expect, it } from "vitest";

import type { NodeType } from "@/types/flow";

import { findReferencedNode, normalizeRefs, refProblem, uniqueRef, upstreamNodeIds } from "./refs";

const n = (id: string, type: NodeType, ref?: string) => ({ id, type, ref });
const data = (source: string, target: string) => ({ source, target, type: "data" });
const tool = (agent: string, toolNode: string) => ({
  source: agent,
  target: toolNode,
  type: "tool_connection",
});

describe("uniqueRef", () => {
  it("uses the prefix, then numbers from 2", () => {
    expect(uniqueRef("agent", [])).toBe("agent");
    expect(uniqueRef("agent", ["agent"])).toBe("agent_2");
    expect(uniqueRef("agent", ["agent", "agent_2", "agent_4"])).toBe("agent_3");
  });
});

describe("normalizeRefs", () => {
  it("assigns refs from the node type, keeping valid existing ones", () => {
    const nodes = normalizeRefs([
      n("n1", "agent_node"),
      n("n2", "agent_node", "parser"),
      n("n3", "agent_node"),
      n("n4", "trigger_manual"),
    ]);
    expect(nodes.map((x) => x.ref)).toEqual(["agent", "parser", "agent_2", "trigger"]);
  });

  it("repairs invalid, reserved, duplicate and id-clashing refs", () => {
    const nodes = normalizeRefs([
      n("n1", "agent_node", "Bad Ref"),
      n("n2", "agent_node", "input"),
      n("n3", "agent_node", "dup"),
      n("n4", "agent_node", "dup"),
      n("n5", "agent_node", "n1"),
    ]);
    expect(nodes.map((x) => x.ref)).toEqual(["agent", "agent_2", "dup", "agent_3", "agent_4"]);
  });

  it("returns the same objects when nothing needs fixing", () => {
    const original = [n("n1", "agent_node", "agent")];
    expect(normalizeRefs(original)[0]).toBe(original[0]);
  });
});

describe("refProblem", () => {
  const nodes = [n("n1", "agent_node", "agent"), n("n2", "tool_http", "api")];
  it.each([
    ["parser", null],
    ["agent", null], // its own current name
    ["", "Enter a name."],
    ["Parser", "Use lowercase"],
    ["2fast", "Use lowercase"],
    ["input", "reserved"],
    ["api", "already called"],
    ["n2", "already called"],
  ])("%s → %s", (ref, expected) => {
    const problem = refProblem(ref, "n1", nodes);
    if (expected === null) expect(problem).toBeNull();
    else expect(problem).toContain(expected);
  });
});

describe("findReferencedNode", () => {
  it("matches refs first, then ids (older flows)", () => {
    const nodes = [n("node_1", "agent_node", "agent"), n("node_2", "tool_http", "api")];
    expect(findReferencedNode("agent", nodes)?.id).toBe("node_1");
    expect(findReferencedNode("node_2", nodes)?.id).toBe("node_2");
    expect(findReferencedNode("missing", nodes)).toBeUndefined();
  });
});

describe("upstreamNodeIds", () => {
  it("lists upstream nodes along data edges, nearest first", () => {
    const edges = [data("t", "a"), data("a", "b"), data("b", "out"), data("x", "b")];
    expect(upstreamNodeIds("out", edges)).toEqual(["b", "a", "x", "t"]);
    expect(upstreamNodeIds("t", edges)).toEqual([]);
  });

  it("gives tools what their agent sees, but not the agent itself", () => {
    const edges = [data("t", "a"), tool("a", "search")];
    expect(upstreamNodeIds("search", edges)).toEqual(["t"]);
  });

  it("handles loops without listing the node itself", () => {
    const edges = [data("t", "loop"), data("loop", "body"), data("body", "loop")];
    expect(upstreamNodeIds("body", edges)).toEqual(["loop", "t"]);
  });
});
