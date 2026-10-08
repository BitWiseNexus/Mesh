import { describe, expect, it } from "vitest";

import type { NodeType } from "@/types/flow";

import {
  checkConnection,
  fromFlow,
  parseFlowJson,
  toFlow,
  type CanvasEdge,
  type CanvasNode,
} from "./graph";

const node = (id: string, type: NodeType): CanvasNode => ({
  id,
  type,
  data: {},
  position: { x: 0, y: 0 },
});

const dataEdge = (source: string, target: string, sourceHandle = "out"): CanvasEdge => ({
  id: `${source}-${target}-${sourceHandle}`,
  source,
  target,
  sourceHandle,
  targetHandle: "in",
  type: "data",
});

const nodes = [
  node("trigger", "trigger_manual"),
  node("agent", "agent_node"),
  node("search", "tool_web_search"),
  node("retriever", "kb_retriever"),
  node("loop", "logic_loop"),
  node("email", "action_email"),
  node("out", "output_display"),
];

const conn = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({
  source,
  sourceHandle,
  target,
  targetHandle,
});

describe("checkConnection", () => {
  it("creates data edges between data handles", () => {
    expect(checkConnection(conn("trigger", "out", "agent", "in"), nodes, [])).toEqual({
      ok: true,
      type: "data",
    });
  });

  it("creates tool_connection edges from an agent's tools handle", () => {
    expect(checkConnection(conn("agent", "tools", "search", "tool"), nodes, [])).toEqual({
      ok: true,
      type: "tool_connection",
    });
    // kb_retriever can be attached as a tool too
    expect(checkConnection(conn("agent", "tools", "retriever", "tool"), nodes, [])).toEqual({
      ok: true,
      type: "tool_connection",
    });
  });

  it("rejects mismatched handle kinds", () => {
    expect(checkConnection(conn("agent", "tools", "out", "in"), nodes, []).ok).toBe(false);
    expect(checkConnection(conn("trigger", "out", "search", "tool"), nodes, []).ok).toBe(false);
  });

  it("rejects self connections, unknown nodes and duplicates", () => {
    expect(checkConnection(conn("agent", "out", "agent", "in"), nodes, []).ok).toBe(false);
    expect(checkConnection(conn("ghost", "out", "agent", "in"), nodes, []).ok).toBe(false);
    expect(
      checkConnection(conn("trigger", "out", "agent", "in"), nodes, [dataEdge("trigger", "agent")])
        .ok,
    ).toBe(false);
  });

  it("rejects cycles that don't pass through a Loop node", () => {
    // email -> agent would close agent -> email -> agent
    expect(
      checkConnection(conn("email", "out", "agent", "in"), nodes, [dataEdge("agent", "email")]),
    ).toEqual({ ok: false, reason: "Cycles must go through a Loop node" });
  });

  it("allows non-cyclic edges into nodes that are already connected", () => {
    expect(
      checkConnection(conn("trigger", "out", "email", "in"), nodes, [dataEdge("agent", "email")]),
    ).toEqual({ ok: true, type: "data" });
  });

  it("allows cycles through a Loop node", () => {
    // loop --loop--> agent exists; agent -> loop closes the cycle
    expect(
      checkConnection(conn("agent", "out", "loop", "in"), nodes, [dataEdge("loop", "agent", "loop")]),
    ).toEqual({ ok: true, type: "data" });
  });

  it("ignores tool edges when detecting cycles", () => {
    const toolEdge: CanvasEdge = {
      id: "t",
      source: "agent",
      target: "retriever",
      sourceHandle: "tools",
      targetHandle: "tool",
      type: "tool_connection",
    };
    expect(checkConnection(conn("retriever", "out", "agent", "in"), nodes, [toolEdge])).toEqual({
      ok: true,
      type: "data",
    });
  });
});

describe("toFlow / fromFlow", () => {
  it("round-trips and strips React Flow UI state", () => {
    const meta = { flow_id: null, name: "Test", description: "" };
    const canvasNodes: CanvasNode[] = [
      { ...node("trigger", "trigger_manual"), selected: true, measured: { width: 10, height: 10 } },
      node("agent", "agent_node"),
    ];
    const flow = toFlow(meta, canvasNodes, [dataEdge("trigger", "agent")]);

    expect(flow.nodes[0]).toEqual({
      id: "trigger",
      type: "trigger_manual",
      data: {},
      position: { x: 0, y: 0 },
    });
    expect(flow.edges[0]).toMatchObject({
      type: "data",
      sourceHandle: "out",
      targetHandle: "in",
      animated: false,
    });

    // Loading gives ref-less nodes a ref (from their type); after that the round trip is exact.
    const back = fromFlow(flow);
    expect(back.nodes.map((n) => n.ref)).toEqual(["trigger", "agent"]);
    const withRefs = toFlow(meta, back.nodes, back.edges);
    const again = fromFlow(withRefs);
    expect(toFlow(meta, again.nodes, again.edges)).toEqual(withRefs);
  });
});

describe("parseFlowJson", () => {
  const spec = {
    flow_id: "flow_12345",
    name: "Support Lead AI Assistant",
    nodes: [
      {
        id: "node_1",
        type: "trigger_manual",
        data: { label: "Start Process" },
        position: { x: 100, y: 200 },
      },
      { id: "node_2", type: "agent_node", data: { model: "gpt-4o" }, position: { x: 400, y: 200 } },
      {
        id: "node_3",
        type: "tool_web_search",
        data: { provider: "tavily" },
        position: { x: 400, y: 400 },
      },
    ],
    edges: [
      { id: "e1-2", source: "node_1", target: "node_2", animated: true },
      { id: "e2-3", source: "node_2", target: "node_3", type: "tool_connection" },
    ],
  };

  it("accepts the spec example", () => {
    const result = parseFlowJson(JSON.stringify(spec));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flow.edges.map((e) => e.type)).toEqual(["data", "tool_connection"]);
    expect(result.flow.edges[0].animated).toBe(true);
    expect(result.flow.schema_version).toBe(1);
  });

  it.each([
    ["not json", "{", "not valid JSON"],
    ["missing arrays", "{}", "`nodes` and `edges`"],
    [
      "unknown node type",
      JSON.stringify({ ...spec, nodes: [{ ...spec.nodes[0], type: "nope" }], edges: [] }),
      "unknown type",
    ],
    [
      "duplicate node",
      JSON.stringify({ ...spec, nodes: [spec.nodes[0], spec.nodes[0]], edges: [] }),
      "Duplicate node ids",
    ],
    [
      "dangling edge",
      JSON.stringify({ ...spec, edges: [{ id: "x", source: "node_1", target: "ghost" }] }),
      "missing node",
    ],
  ])("rejects %s", (_name, text, message) => {
    const result = parseFlowJson(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
});

describe("withFieldDefaults", () => {
  it("fills fields a node type gained later, keeping existing and unknown values", async () => {
    const { withFieldDefaults } = await import("./graph");
    const old = { model: "claude-sonnet-5-5", system_prompt: "Be brief", custom: 1 };
    expect(withFieldDefaults("agent_node", old)).toEqual({
      ...old,
      credential_id: null,
      prompt: "{{input}}",
      temperature: 0.7,
      max_tool_steps: 5,
      tool_description: "",
    });
    const complete = withFieldDefaults("agent_node", {});
    expect(withFieldDefaults("agent_node", complete)).toBe(complete); // nothing to add → same object
  });
});
