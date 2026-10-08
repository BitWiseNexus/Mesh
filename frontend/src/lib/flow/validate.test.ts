import { describe, expect, it } from "vitest";

import { createDefaultData } from "@/lib/nodes/registry";
import type { NodeData, NodeType } from "@/types/flow";

import type { CanvasEdge, CanvasNode } from "./graph";
import { createFlowFromTemplate } from "./templates";
import { issuesByNode, validateFlow } from "./validate";

const node = (id: string, type: NodeType, data: NodeData = createDefaultData(type)): CanvasNode => ({
  id,
  type,
  data,
  position: { x: 0, y: 0 },
});

const edge = (
  source: string,
  target: string,
  sourceHandle = "out",
  type: CanvasEdge["type"] = "data",
): CanvasEdge => ({
  id: `${source}-${sourceHandle}-${target}`,
  source,
  target,
  sourceHandle,
  targetHandle: type === "tool_connection" ? "tool" : "in",
  type,
});

const ids = (nodes: CanvasNode[], edges: CanvasEdge[]) => validateFlow(nodes, edges).map((i) => i.id);

describe("validateFlow", () => {
  it("accepts the starter template", () => {
    const flow = createFlowFromTemplate("starter");
    expect(validateFlow(flow.nodes as CanvasNode[], flow.edges as CanvasEdge[])).toEqual([]);
  });

  it("requires a trigger and offers a fix", () => {
    const issues = validateFlow([node("out", "output_display")], []);
    expect(issues[0]).toMatchObject({ id: "no-trigger", severity: "error", fix: "add_trigger" });
  });

  it("flags an empty canvas as missing a trigger", () => {
    expect(ids([], [])).toEqual(["no-trigger"]);
  });

  it("allows multiple triggers", () => {
    const nodes = [node("t1", "trigger_manual"), node("t2", "trigger_manual"), node("out", "output_display")];
    expect(ids(nodes, [edge("t1", "out"), edge("t2", "out")])).toEqual([]);
  });

  it("warns about nodes not reachable from a trigger", () => {
    const nodes = [node("t", "trigger_manual"), node("a", "agent_node"), node("out", "output_display")];
    expect(ids(nodes, [edge("a", "out")])).toEqual(["unreachable:a", "unreachable:out"]);
  });

  it("treats tools attached to reachable agents as reachable", () => {
    const nodes = [node("t", "trigger_manual"), node("a", "agent_node"), node("s", "tool_web_search")];
    expect(ids(nodes, [edge("t", "a"), edge("a", "s", "tools", "tool_connection")])).toEqual([]);
  });

  it("warns about tools not attached to any agent", () => {
    const nodes = [node("t", "trigger_manual"), node("s", "tool_web_search")];
    expect(ids(nodes, [])).toEqual(["unattached:s"]);
  });

  it("warns when a loop has no body", () => {
    const nodes = [node("t", "trigger_manual"), node("l", "logic_loop")];
    expect(ids(nodes, [edge("t", "l")])).toEqual(["empty-loop:l"]);
  });

  it("reports empty required fields as errors, before warnings", () => {
    const nodes = [
      node("t", "trigger_manual"),
      node("orphan", "output_display"),
      node("a", "agent_node"),
      node("api", "tool_http"),
    ];
    const issues = validateFlow(nodes, [edge("t", "a"), edge("a", "api", "tools", "tool_connection")]);
    expect(issues.map((i) => i.id)).toEqual(["required:api:url", "unreachable:orphan"]);
    expect(issues[0]).toMatchObject({ severity: "error", nodeId: "api", field: "url" });
    expect(issues[0].message).toContain("URL is required");
  });

  it("flags retired node types with what replaced them, instead of 'not available'", () => {
    const nodes = [node("t", "trigger_manual"), node("n", "kb_notion", { page_ids: ["p1"] })];
    const issues = validateFlow(nodes, [edge("t", "n")]);
    expect(issues.map((i) => i.id)).toContain("deprecated:n");
    expect(issues.map((i) => i.id)).not.toContain("unavailable:n");
    expect(issues.find((i) => i.id === "deprecated:n")?.message).toContain("knowledge-base source");
  });

  it("flags nodes that aren't available yet", () => {
    const nodes = [
      node("t", "trigger_manual"),
      node("mail", "action_email", { ...createDefaultData("action_email"), to: "a@b.co", subject: "Hi" }),
    ];
    expect(ids(nodes, [edge("t", "mail")])).toEqual(["unavailable:mail"]);
  });

  it.each([
    ["number below range", "agent_node", { temperature: -1 }, "Temperature must be between 0 and 2"],
    ["number above range", "agent_node", { temperature: 5 }, "Temperature must be between 0 and 2"],
    ["number as text", "agent_node", { temperature: "hot" }, "Temperature must be a number"],
    ["json object expected", "tool_http", { url: "https://x.io", headers: ["x"] }, "Headers must be a JSON object"],
    ["unknown select option", "tool_web_search", { provider: "bing" }, "Provider has an unsupported value"],
  ])("rejects invalid values: %s", (_name, type, patch, message) => {
    const t = type as NodeType;
    const nodes = [
      node("t", "trigger_manual"),
      node("a", "agent_node"),
      node("x", t, { ...createDefaultData(t), ...patch }),
    ];
    const edges =
      t === "agent_node"
        ? [edge("t", "x")]
        : [edge("t", "a"), edge("a", "x", "tools", "tool_connection")];
    const issues = validateFlow(nodes, edges);
    expect(issues.map((i) => i.message)).toContainEqual(expect.stringContaining(message));
    expect(issues.find((i) => i.message.includes(message))).toMatchObject({ severity: "error", nodeId: "x" });
  });

  it("uses the node's custom label in messages", () => {
    const nodes = [node("t", "trigger_manual"), node("a", "agent_node", { ...createDefaultData("agent_node"), label: "Lead Parser" })];
    expect(validateFlow(nodes, [])[0].message).toContain("“Lead Parser”");
  });
});

describe("issuesByNode", () => {
  it("groups node issues and skips flow-level ones", () => {
    const issues = validateFlow([node("s", "tool_web_search")], []);
    expect(Object.keys(issuesByNode(issues))).toEqual(["s"]);
  });
});

describe("template references", () => {
  const withRef = (id: string, type: NodeType, ref: string, data?: NodeData): CanvasNode => ({
    ...node(id, type, data),
    ref,
  });
  // trigger → agent → if; agent.tools → api
  const base = () => [
    withRef("t", "trigger_manual", "trigger"),
    withRef("a", "agent_node", "agent"),
    withRef("api", "tool_http", "api"),
  ];
  const edges = [
    edge("t", "a"),
    edge("a", "api", "tools", "tool_connection"),
  ];
  const ifNode = (field: string) =>
    withRef("i", "logic_if", "if", { ...createDefaultData("logic_if"), field });
  const issuesFor = (field: string) =>
    validateFlow([...base(), ifNode(field)], [...edges, edge("a", "i")]).filter(
      (i) => i.id === "reference:i:field",
    );

  it.each([
    "{{input}}",
    "{{agent.output}}",
    "{{agent.output.summary}} and {{trigger.output}}",
    "{{a.output}}", // by node id (older flows)
  ])("accepts %s", (field) => {
    expect(issuesFor(field)).toEqual([]);
  });

  it.each([
    ["{{agent}}", "has an invalid reference {{agent}}"],
    ["{{ghost.output}}", "no node is called “ghost”"],
    ["{{if.output}}", "this node's own output"],
    ["{{api.output}}", "“API Caller”, which doesn't run before this node"],
  ])("rejects %s", (field, message) => {
    const [issue] = issuesFor(field);
    expect(issue).toMatchObject({ severity: "error", nodeId: "i", field: "field" });
    expect(issue.message).toContain(message);
  });

  it("lets a tool reference what its agent can see, but not the agent itself", () => {
    const api = (url: string) =>
      withRef("api", "tool_http", "api", { ...createDefaultData("tool_http"), url });
    const run = (url: string) =>
      validateFlow([base()[0], base()[1], api(url)], edges).filter((i) =>
        i.id.startsWith("reference:api"),
      );
    expect(run("https://x.io/{{trigger.output}}")).toEqual([]);
    expect(run("https://x.io/{{agent.output}}")[0].message).toContain("doesn't run before");
  });

  it("only checks templated fields", () => {
    const hook = withRef("w", "trigger_webhook", "webhook", {
      ...createDefaultData("trigger_webhook"),
      secret: "{{nonsense}}",
    });
    expect(validateFlow([hook], []).some((i) => i.id.startsWith("reference:"))).toBe(false);
  });
});

describe("tools, workers and multiple inputs (R3)", () => {
  const agent = (id: string, data?: NodeData) => ({
    ...node(id, "agent_node", data ?? createDefaultData("agent_node")),
    ref: id,
  });
  const toolEdge = (from: string, to: string) => edge(from, to, "tools", "tool_connection");

  it("lets an agent be attached to another agent as a tool", () => {
    const nodes = [node("t", "trigger_manual"), agent("lead"), agent("worker")];
    expect(ids(nodes, [edge("t", "lead"), toolEdge("lead", "worker")])).toEqual([]);
  });

  it("rejects a node that is both a tool and a step", () => {
    const nodes = [node("t", "trigger_manual"), agent("lead"), agent("worker")];
    const issues = ids(nodes, [edge("t", "lead"), toolEdge("lead", "worker"), edge("t", "worker")]);
    expect(issues).toContain("tool-and-step:worker");
  });

  it("rejects tool attachments that form a loop", () => {
    const nodes = [node("t", "trigger_manual"), agent("a"), agent("b")];
    const issues = ids(nodes, [edge("t", "a"), toolEdge("a", "b"), toolEdge("b", "a")]);
    expect(issues).toEqual(expect.arrayContaining(["tool-cycle:a", "tool-cycle:b"]));
  });

  describe("{{input}} with several inputs", () => {
    const build = (prompt: string) => [
      { ...node("t", "trigger_manual"), ref: "trigger" },
      agent("a"),
      agent("b"),
      agent("join", { ...createDefaultData("agent_node"), prompt }),
    ];
    const edges = [edge("t", "a"), edge("t", "b"), edge("a", "join"), edge("b", "join")];
    const warning = (prompt: string) =>
      validateFlow(build(prompt), edges).find((i) => i.id === "ambiguous-input:join:prompt");

    it.each(["{{input}}", "{{input.title}}"])("warns for %s", (prompt) => {
      expect(warning(prompt)).toMatchObject({ severity: "warning", field: "prompt" });
    });

    it.each(["{{input.a}} vs {{input.b}}", "{{a.output}}", "no reference"])("accepts %s", (prompt) => {
      expect(warning(prompt)).toBeUndefined();
    });

    it("doesn't warn with a single input", () => {
      const single = validateFlow(build("{{input}}").slice(0, 2), [edge("t", "a")]);
      expect(single.some((i) => i.id.startsWith("ambiguous-input"))).toBe(false);
    });
  });
});
