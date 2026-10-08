import { describe, expect, it } from "vitest";

import { NODE_TYPES } from "@/types/flow";

import { createDefaultData, NODE_REGISTRY, NODES_BY_CATEGORY } from "./registry";

describe("node registry", () => {
  it.each(NODE_TYPES)("%s is consistent", (type) => {
    const def = NODE_REGISTRY[type];
    expect(def.type).toBe(type);

    // Every config field has a default value.
    for (const field of def.fields) {
      expect(def.defaultData, `${type}.${field.key}`).toHaveProperty(field.key);
    }

    // Handle ids are unique per side.
    for (const handles of [def.inputs, def.outputs]) {
      const ids = handles.map((h) => h.id);
      expect(new Set(ids).size).toBe(ids.length);
    }

    // Tool nodes are attached, never executed as steps.
    if (def.category === "tool") {
      expect(def.inputs.map((h) => h.id)).toEqual(["tool"]);
      expect(def.outputs).toEqual([]);
    }
  });

  it("groups every non-retired node into exactly one palette category", () => {
    const grouped = NODES_BY_CATEGORY.flatMap((g) => g.nodes.map((n) => n.type));
    const active = NODE_TYPES.filter((t) => !NODE_REGISTRY[t].deprecated);
    expect(grouped.sort()).toEqual([...active].sort());
    expect(grouped).not.toContain("kb_notion");
  });

  it("returns independent copies of default data", () => {
    const a = createDefaultData("tool_http");
    (a.headers as Record<string, string>).x = "1";
    expect(createDefaultData("tool_http").headers).toEqual({});
  });
});
