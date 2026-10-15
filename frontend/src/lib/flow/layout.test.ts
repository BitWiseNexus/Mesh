import { describe, expect, it } from "vitest";

import type { NodeType } from "@/types/flow";

import { NODE_HEIGHT, NODE_WIDTH, type CanvasEdge, type CanvasNode } from "./graph";
import { backEdges, computeLayout, LAYER_GAP, TOOL_ROW_GAP } from "./layout";

const node = (id: string, type: NodeType, x = 0, y = 0): CanvasNode => ({
  id,
  type,
  data: {},
  position: { x, y },
});
const edge = (source: string, target: string, sourceHandle = "out", type: CanvasEdge["type"] = "data"): CanvasEdge => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle,
  targetHandle: type === "data" ? "in" : "tool",
  type,
});

const overlaps = (positions: Map<string, { x: number; y: number }>) => {
  const boxes = [...positions.values()];
  return boxes.some((a, i) =>
    boxes.some(
      (b, j) =>
        i < j &&
        a.x < b.x + NODE_WIDTH &&
        b.x < a.x + NODE_WIDTH &&
        a.y < b.y + NODE_HEIGHT &&
        b.y < a.y + NODE_HEIGHT,
    ),
  );
};

describe("computeLayout", () => {
  it("lays a chain out left to right on one line, keeping its top-left corner", async () => {
    // Scrambled positions; top-left of the flow at (100, 50).
    const nodes = [node("t", "trigger_manual", 900, 50), node("a", "agent_node", 100, 400), node("o", "output_display", 500, 900)];
    const p = await computeLayout(nodes, [edge("t", "a"), edge("a", "o")]);
    expect(p.get("t")).toEqual({ x: 100, y: 50 });
    expect(p.get("a")).toEqual({ x: 100 + NODE_WIDTH + LAYER_GAP, y: 50 });
    expect(p.get("o")).toEqual({ x: 100 + 2 * (NODE_WIDTH + LAYER_GAP), y: 50 });
  });

  it("puts an agent's tools in a row underneath it, its edges still straight", async () => {
    const nodes = [
      node("t", "trigger_manual"),
      node("a", "agent_node"),
      node("o", "output_display"),
      node("s", "tool_web_search"),
      node("h", "tool_http"),
    ];
    const edges = [edge("t", "a"), edge("a", "o"), edge("a", "s", "tools", "tool_connection"), edge("a", "h", "tools", "tool_connection")];
    const p = await computeLayout(nodes, edges);
    const [t, a, o, s, h] = ["t", "a", "o", "s", "h"].map((id) => p.get(id)!);
    expect(t.y).toBe(a.y);
    expect(o.y).toBe(a.y);
    expect(s.y).toBe(a.y + NODE_HEIGHT + TOOL_ROW_GAP);
    expect(h.y).toBe(s.y);
    expect(s.x).toBeLessThan(h.x);
    expect((s.x + h.x + NODE_WIDTH) / 2).toBeCloseTo(a.x + NODE_WIDTH / 2, -1); // centred
    expect(o.x).toBeGreaterThan(h.x + NODE_WIDTH); // the tool row has room
    expect(overlaps(p)).toBe(false);
  });

  it("keeps a loop's body after the Loop, and branches apart", async () => {
    const nodes = [
      node("t", "trigger_manual"),
      node("l", "logic_loop"),
      node("b", "agent_node"),
      node("i", "logic_if"),
      node("o", "output_display"),
      node("x", "output_display"),
    ];
    const edges = [edge("t", "l"), edge("l", "b", "loop"), edge("b", "i"), edge("i", "l", "false"), edge("i", "x", "true"), edge("l", "o", "done")];
    const p = await computeLayout(nodes, edges);
    const x = (id: string) => p.get(id)!.x;
    const y = (id: string) => p.get(id)!.y;
    expect(y("b")).toBeLessThan(y("o")); // Loop's "loop" output is above "done": no crossing
    expect(x("t")).toBeLessThan(x("l"));
    expect(x("l")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("i"));
    expect(x("i")).toBeLessThan(x("x"));
    expect(overlaps(p)).toBe(false);
  });

  it("uses measured sizes and handles empty flows and loose nodes", async () => {
    expect((await computeLayout([], [])).size).toBe(0);
    const tall = { ...node("a", "agent_node"), measured: { width: 240, height: 300 } };
    const p = await computeLayout([tall, node("b", "agent_node"), node("c", "agent_node")], []);
    expect(p.size).toBe(3);
    expect(overlaps(p)).toBe(false);
    const [a, b] = [p.get("a")!, p.get("b")!];
    expect(a.x === b.x ? Math.abs(a.y - b.y) >= 300 : true).toBe(true);
  });
});

describe("backEdges", () => {
  it("finds the edges that close a cycle, walking from the triggers", () => {
    const nodes = [node("b", "agent_node"), node("l", "logic_loop"), node("t", "trigger_manual")];
    const edges = [edge("t", "l"), edge("l", "b", "loop"), edge("b", "l")];
    expect([...backEdges(nodes, edges)]).toEqual(["b-l"]);
    expect(backEdges(nodes, edges.slice(0, 2)).size).toBe(0);
  });
});
