import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatInput,
  formatReference,
  parseTemplate,
  referencedNodes,
  renameReferences,
  type TemplatePart,
} from "./references";

/** Shared with the backend's parser tests — both must agree exactly. */
const cases = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../shared/template-cases.json"), "utf8"),
) as {
  parse: { text: string; parts: TemplatePart[] }[];
  rename: { text: string; from: string; to: string; result: string }[];
};

describe("parseTemplate (shared cases)", () => {
  it.each(cases.parse)("$text", ({ text, parts }) => {
    expect(parseTemplate(text)).toEqual(parts);
  });
});

describe("renameReferences (shared cases)", () => {
  it.each(cases.rename)("$text: $from → $to", ({ text, from, to, result }) => {
    expect(renameReferences(text, from, to)).toBe(result);
  });
});

describe("formatting", () => {
  it("round-trips through the parser", () => {
    expect(parseTemplate(formatReference("agent", ["items", "0"]))).toEqual([
      { kind: "ref", node: "agent", path: ["items", "0"] },
    ]);
    expect(formatInput()).toBe("{{input}}");
  });

  it("lists referenced nodes once, in order", () => {
    expect(referencedNodes("{{b.output}} {{a.output.x}} {{b.output.y}} {{input}}")).toEqual([
      "b",
      "a",
    ]);
  });
});
