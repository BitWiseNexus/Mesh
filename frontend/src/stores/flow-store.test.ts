import { beforeEach, describe, expect, it } from "vitest";

import { useFlowStore } from "./flow-store";

const store = () => useFlowStore.getState();

beforeEach(() => {
  store().newFlow();
});

describe("flow store", () => {
  it("adds nodes with registry defaults and selects them", () => {
    const id = store().addNode("agent_node", { x: 10, y: 20 });
    const node = store().nodes.find((n) => n.id === id)!;
    expect(node.data).toMatchObject({ model: "gpt-4o", temperature: 0.7 });
    expect(store().selectedNodeId).toBe(id);
  });

  it("connects nodes with the right edge type and rejects invalid connections", () => {
    const agent = store().addNode("agent_node", { x: 0, y: 0 });
    const tool = store().addNode("tool_web_search", { x: 0, y: 100 });

    const ok = store().onConnect({
      source: agent,
      sourceHandle: "tools",
      target: tool,
      targetHandle: "tool",
    });
    expect(ok).toEqual({ ok: true, type: "tool_connection" });
    expect(store().edges).toHaveLength(1);

    const bad = store().onConnect({
      source: agent,
      sourceHandle: "out",
      target: tool,
      targetHandle: "tool",
    });
    expect(bad.ok).toBe(false);
    expect(store().edges).toHaveLength(1);
  });

  it("deleting a node removes its edges", () => {
    const a = store().addNode("trigger_manual", { x: 0, y: 0 });
    const b = store().addNode("agent_node", { x: 200, y: 0 });
    store().onConnect({ source: a, sourceHandle: "out", target: b, targetHandle: "in" });
    store().deleteNode(b);
    expect(store().nodes.map((n) => n.id)).toEqual([a]);
    expect(store().edges).toEqual([]);
  });

  it("undoes and redoes edits", () => {
    const a = store().addNode("trigger_manual", { x: 0, y: 0 });
    store().addNode("agent_node", { x: 200, y: 0 });
    expect(store().nodes).toHaveLength(2);

    store().undo();
    expect(store().nodes.map((n) => n.id)).toEqual([a]);
    store().undo();
    expect(store().nodes).toEqual([]);
    store().redo();
    expect(store().nodes.map((n) => n.id)).toEqual([a]);
  });

  it("coalesces rapid edits to the same field into one undo step", () => {
    const id = store().addNode("agent_node", { x: 0, y: 0 });
    store().updateNodeData(id, { system_prompt: "H" });
    store().updateNodeData(id, { system_prompt: "He" });
    store().updateNodeData(id, { system_prompt: "Hey" });
    store().undo();
    expect(store().nodes[0].data.system_prompt).toBe("");
  });

  it("snapshots once at the start of a drag", () => {
    const id = store().addNode("agent_node", { x: 0, y: 0 });
    const before = store().past.length;
    store().onNodesChange([{ type: "position", id, position: { x: 5, y: 5 }, dragging: true }]);
    store().onNodesChange([{ type: "position", id, position: { x: 9, y: 9 }, dragging: true }]);
    store().onNodesChange([{ type: "position", id, position: { x: 9, y: 9 }, dragging: false }]);
    expect(store().past.length).toBe(before + 1);
    store().undo();
    expect(store().nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it("serializes to Flow JSON and loads it back", () => {
    const a = store().addNode("trigger_manual", { x: 0, y: 0 });
    const b = store().addNode("output_display", { x: 200, y: 0 });
    store().onConnect({ source: a, sourceHandle: "out", target: b, targetHandle: "in" });
    store().setMeta({ name: "My flow" });

    const flow = store().toFlow();
    expect(flow).toMatchObject({ schema_version: 1, flow_id: null, name: "My flow" });
    expect(flow.nodes).toHaveLength(2);

    store().newFlow();
    store().loadFlow(flow);
    expect(store().toFlow()).toEqual(flow);
    expect(store().past).toEqual([]); // loading resets history
  });

  it("persists a draft to localStorage without UI state or history", () => {
    store().addNode("trigger_manual", { x: 5, y: 5 });
    const saved = JSON.parse(localStorage.getItem("mesh:flow-draft")!);
    expect(saved.state.nodes).toHaveLength(1);
    expect(saved.state.nodes[0]).not.toHaveProperty("selected");
    expect(saved.state).not.toHaveProperty("past");
  });
});
