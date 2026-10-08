import { beforeEach, describe, expect, it } from "vitest";

import {
  bindDraft,
  draftKeyFor,
  findLegacyDraft,
  flushDraft,
  parseStoredDraft,
  readDraftBackup,
  useFlowStore,
} from "./flow-store";

const store = () => useFlowStore.getState();

beforeEach(() => {
  store().newFlow("blank");
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

    store().newFlow("blank");
    store().loadFlow(flow);
    expect(store().toFlow()).toEqual(flow);
    expect(store().past).toEqual([]); // loading resets history
  });

  it("starts new flows from the starter template", () => {
    store().newFlow();
    expect(store().nodes.map((n) => n.type)).toEqual(["trigger_manual", "output_display"]);
    expect(store().edges).toHaveLength(1);
    expect(store().issues).toEqual([]);
  });

  it("keeps validation issues in sync with the graph", () => {
    expect(store().issues.map((i) => i.id)).toEqual(["no-trigger"]);
    const trigger = store().addNode("trigger_manual", { x: 0, y: 0 });
    expect(store().issues).toEqual([]);

    const agent = store().addNode("agent_node", { x: 300, y: 0 });
    const api = store().addNode("tool_http", { x: 300, y: 200 });
    expect(store().nodeIssues[api].map((i) => i.field ?? i.id)).toEqual(["url", `unattached:${api}`]);

    store().onConnect({ source: trigger, sourceHandle: "out", target: agent, targetHandle: "in" });
    store().onConnect({ source: agent, sourceHandle: "tools", target: api, targetHandle: "tool" });
    store().updateNodeData(api, { url: "https://api.example.com" });
    expect(store().issues).toEqual([]);
  });

  it("doesn't replace issues when only positions change", () => {
    const id = store().addNode("tool_web_search", { x: 0, y: 0 });
    const before = store().issues;
    store().onNodesChange([{ type: "position", id, position: { x: 50, y: 50 }, dragging: true }]);
    expect(store().issues).toBe(before);
  });

  it("makes one deletion a single undo step, but separate deletions separate steps", async () => {
    const a = store().addNode("trigger_manual", { x: 0, y: 0 });
    const b = store().addNode("output_display", { x: 300, y: 0 });
    const c = store().addNode("output_display", { x: 300, y: 200 });
    store().onConnect({ source: a, sourceHandle: "out", target: b, targetHandle: "in" });
    const edgeId = store().edges[0].id;

    // React Flow deletes node b as a node change + an edge change in the same tick.
    store().onNodesChange([{ type: "remove", id: b }]);
    store().onEdgesChange([{ type: "remove", id: edgeId }]);
    await Promise.resolve();
    store().onNodesChange([{ type: "remove", id: c }]);
    expect(store().nodes.map((n) => n.id)).toEqual([a]);

    store().undo();
    expect(store().nodes.map((n) => n.id)).toEqual([a, c]);
    store().undo();
    expect(store().nodes.map((n) => n.id)).toEqual([a, b, c]);
    expect(store().edges).toHaveLength(1);
  });


  it("tracks the server version it was loaded from", () => {
    const flow = { ...store().toFlow(), flow_id: "f1", version: 4 };
    store().loadFlow(flow);
    expect(store().version).toBe(4);
    store().markSaved("f1", 5, store().fingerprint);
    expect(store().version).toBe(5);
    expect(store().toFlow()).not.toHaveProperty("version");
  });

  describe("unsaved changes", () => {
    const load = () => {
      store().newFlow("starter");
      store().loadFlow({ ...store().toFlow(), flow_id: "f1", version: 1 });
    };

    it("is clean after loading, dirty after an edit, clean again after undoing it", () => {
      load();
      expect(store().dirty).toBe(false);
      store().addNode("agent_node", { x: 0, y: 0 });
      expect(store().dirty).toBe(true);
      store().undo();
      expect(store().dirty).toBe(false);
    });

    it("counts renames and node moves, but not selection", () => {
      load();
      const id = store().nodes[0].id;
      store().selectNode(id);
      expect(store().dirty).toBe(false);
      store().setMeta({ name: "Renamed" });
      expect(store().dirty).toBe(true);
      store().setMeta({ name: "Untitled flow" });
      expect(store().dirty).toBe(false);
      store().onNodesChange([{ type: "position", id, position: { x: 99, y: 0 } }]);
      expect(store().dirty).toBe(true);
    });

    it("markSaved clears dirty for the saved content only", () => {
      load();
      store().setMeta({ name: "A" });
      const savedFingerprint = store().fingerprint;
      store().setMeta({ name: "AB" }); // edited while the save was in flight
      store().markSaved("f1", 2, savedFingerprint);
      expect(store().version).toBe(2);
      expect(store().save).toMatchObject({ status: "idle", failures: 0 });
      expect(store().save.lastSavedAt).not.toBeNull();
      expect(store().dirty).toBe(true); // "AB" isn't saved yet

      store().markSaved("f1", 3, store().fingerprint);
      expect(store().dirty).toBe(false);
    });

    it("ignores saves that finish after another flow was opened", () => {
      load();
      store().setMeta({ name: "A" });
      const fingerprint = store().fingerprint;
      store().loadFlow({ ...store().toFlow(), flow_id: "f2", version: 7 });
      store().markSaved("f1", 2, fingerprint);
      expect(store()).toMatchObject({ flowId: "f2", version: 7 });
    });

    it("restoreLocal applies recovered content as an undoable, unsaved change", () => {
      load();
      const recovered = { ...store().toFlow(), name: "Recovered", flow_id: "elsewhere" };
      store().restoreLocal(recovered);
      expect(store()).toMatchObject({ name: "Recovered", flowId: "f1", version: 1, dirty: true });
      store().undo();
      expect(store().dirty).toBe(false);
    });
  });

  describe("local draft backup", () => {
    const read = (key: string) => JSON.parse(localStorage.getItem(key)!);

    it("writes the open flow to a per-user, per-flow key after edits settle", () => {
      localStorage.clear();
      bindDraft("alice", "flow_a");
      store().addNode("trigger_manual", { x: 5, y: 5 });
      expect(localStorage.getItem(draftKeyFor("alice", "flow_a"))).toBeNull(); // debounced
      flushDraft();
      const saved = read(draftKeyFor("alice", "flow_a"));
      expect(saved.version).toBe(3);
      expect(saved.state.flow.nodes).toHaveLength(1);
      expect(saved.state.flow.nodes[0]).not.toHaveProperty("selected");
      expect(saved.state).not.toHaveProperty("past");
    });

    it("records the server version the backup is based on", () => {
      localStorage.clear();
      bindDraft("alice", "f9");
      store().loadFlow({ ...store().toFlow(), flow_id: "f9", version: 4 });
      store().setMeta({ name: "Offline edit" });
      flushDraft();
      expect(readDraftBackup("alice", "f9")).toMatchObject({
        baseVersion: 4,
        flow: { name: "Offline edit" },
      });
      expect(readDraftBackup("alice", "missing")).toBeNull();
    });

    it("finishes the previous flow's pending write under its own key when switching", () => {
      localStorage.clear();
      bindDraft("alice", "flow_a");
      store().setMeta({ name: "A" });
      bindDraft("alice", "flow_b"); // flushes A's pending write first
      store().setMeta({ name: "B" });
      flushDraft();
      expect(read(draftKeyFor("alice", "flow_a")).state.flow.name).toBe("A");
      expect(read(draftKeyFor("alice", "flow_b")).state.flow.name).toBe("B");
    });
  });

  describe("legacy drafts (pre-dashboard)", () => {
    const v2 = (flow: object) => JSON.stringify({ version: 2, state: { flow } });
    const node = { id: "n1", type: "trigger_manual", data: {}, position: { x: 0, y: 0 } };

    it("parses v1 and v2 drafts and rejects invalid ones", () => {
      expect(parseStoredDraft(v2({ name: "Two", nodes: [node], edges: [] }))?.name).toBe("Two");
      expect(
        parseStoredDraft(
          JSON.stringify({ version: 1, state: { name: "One", nodes: [node], edges: [] } }),
        )?.name,
      ).toBe("One");
      expect(parseStoredDraft(v2({ name: "x", nodes: [{ ...node, type: "gone" }], edges: [] }))).toBeNull();
      expect(parseStoredDraft("{not json")).toBeNull();
      expect(parseStoredDraft(null)).toBeNull();
    });

    it("finds the user's or the shared pre-auth draft, skipping empty ones", () => {
      localStorage.clear();
      expect(findLegacyDraft("alice")).toBeNull();
      localStorage.setItem("mesh:flow-draft", v2({ name: "Empty", nodes: [], edges: [] }));
      expect(findLegacyDraft("alice")).toBeNull();
      localStorage.setItem("mesh:flow-draft:alice", v2({ name: "Alice's", nodes: [node], edges: [] }));
      expect(findLegacyDraft("alice")).toMatchObject({
        key: "mesh:flow-draft:alice",
        flow: { name: "Alice's" },
      });
      expect(findLegacyDraft("bob")).toBeNull();
    });
  });
});

describe("node refs", () => {
  beforeEach(() => store().newFlow("blank"));

  it("gives new nodes readable unique refs", () => {
    store().addNode("agent_node", { x: 0, y: 0 });
    store().addNode("agent_node", { x: 0, y: 100 });
    store().addNode("tool_http", { x: 0, y: 200 });
    expect(store().nodes.map((n) => n.ref)).toEqual(["agent", "agent_2", "api"]);
  });

  it("renames a ref and rewrites references to it, as one undoable step", () => {
    const agent = store().addNode("agent_node", { x: 0, y: 0 });
    const mail = store().addNode("action_email", { x: 0, y: 100 });
    store().updateNodeData(mail, {
      subject: "Lead: {{agent.output.name}}",
      body: "{{agent.output}} / {{agent_2.output}} / {{input}}",
      to: "{{agent.output}}",
    });
    // Non-templated fields are left alone.
    store().updateNodeData(agent, { system_prompt: "Uses {{agent.output}} literally" });

    expect(store().renameRef(agent, "parser")).toBeNull();
    const node = (id: string) => store().nodes.find((n) => n.id === id)!;
    expect(node(agent).ref).toBe("parser");
    expect(node(mail).data).toMatchObject({
      subject: "Lead: {{parser.output.name}}",
      body: "{{parser.output}} / {{agent_2.output}} / {{input}}",
      to: "{{parser.output}}",
    });
    // system_prompt *is* templated, so it's rewritten too.
    expect(node(agent).data.system_prompt).toBe("Uses {{parser.output}} literally");

    store().undo();
    expect(node(agent).ref).toBe("agent");
    expect(node(mail).data.subject).toBe("Lead: {{agent.output.name}}");
  });

  it("refuses names that are invalid or taken, changing nothing", () => {
    const a = store().addNode("agent_node", { x: 0, y: 0 });
    store().addNode("tool_http", { x: 0, y: 100 });
    const before = store().past.length;
    expect(store().renameRef(a, "api")).toContain("already called");
    expect(store().renameRef(a, "Not Valid")).toContain("lowercase");
    expect(store().nodes[0].ref).toBe("agent");
    expect(store().past.length).toBe(before);
  });

  it("assigns refs to flows saved before refs existed, without marking them unsaved", () => {
    store().loadFlow({
      schema_version: 1,
      flow_id: "f1",
      name: "Old",
      description: "",
      version: 3,
      nodes: [
        { id: "n1", type: "trigger_manual", data: {}, position: { x: 0, y: 0 } },
        { id: "n2", type: "agent_node", data: {}, position: { x: 1, y: 0 } },
      ],
      edges: [],
    });
    expect(store().nodes.map((n) => n.ref)).toEqual(["trigger", "agent"]);
    expect(store().dirty).toBe(false);
    expect(store().toFlow().nodes.map((n) => n.ref)).toEqual(["trigger", "agent"]);
  });
});
