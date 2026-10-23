import { describe, expect, it } from "vitest";

import { cellText, tableColumns } from "./tables";

describe("tableColumns", () => {
  it("lists every field once, in the order they first appear", () => {
    const rows = [
      { data: { name: "Grace", plan: "pro" } },
      { data: { name: "Ada", email: "ada@example.com", plan: "free" } },
      { data: {} },
    ];
    expect(tableColumns(rows)).toEqual(["name", "plan", "email"]);
    expect(tableColumns([])).toEqual([]);
  });
});

describe("cellText", () => {
  it("shows text as it is and other values as JSON", () => {
    expect(cellText("Ada")).toBe("Ada");
    expect(cellText(42)).toBe("42");
    expect(cellText(false)).toBe("false");
    expect(cellText(null)).toBe("null");
    expect(cellText({ a: [1, 2] })).toBe('{"a":[1,2]}');
    expect(cellText(undefined)).toBeNull();
  });
});
