import { describe, expect, it } from "vitest";

import type { Flow } from "@/types/flow";

import { contentFingerprint, stableStringify } from "./fingerprint";

const flow: Flow = {
  schema_version: 1,
  flow_id: "f1",
  name: "Flow",
  description: "",
  nodes: [
    { id: "n1", type: "agent_node", data: { model: "gpt-4o", temperature: 0.7 }, position: { x: 1, y: 2 } },
  ],
  edges: [],
};

describe("stableStringify", () => {
  it("ignores object key order at every depth but keeps array order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});

describe("contentFingerprint", () => {
  it("is equal for the same content regardless of key order, id or version", () => {
    const reordered: Flow = {
      ...flow,
      flow_id: "other",
      nodes: [{ ...flow.nodes[0], data: { temperature: 0.7, model: "gpt-4o" } }],
    };
    expect(contentFingerprint(reordered)).toBe(contentFingerprint(flow));
  });

  it.each([
    ["name", { name: "Renamed" }],
    ["description", { description: "New" }],
    ["node data", { nodes: [{ ...flow.nodes[0], data: { model: "gpt-4o", temperature: 0.2 } }] }],
    ["node position", { nodes: [{ ...flow.nodes[0], position: { x: 5, y: 2 } }] }],
  ])("changes when the %s changes", (_what, patch) => {
    expect(contentFingerprint({ ...flow, ...patch })).not.toBe(contentFingerprint(flow));
  });
});
