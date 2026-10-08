import { describe, expect, it } from "vitest";

import type { Flow } from "@/types/flow";

import { decideRecovery } from "./recovery";

const server: Flow & { version: number } = {
  schema_version: 1,
  flow_id: "f1",
  name: "Flow",
  description: "",
  nodes: [{ id: "n1", type: "trigger_manual", data: {}, position: { x: 0, y: 0 } }],
  edges: [],
  version: 3,
};
const edited: Flow = { ...server, name: "Edited offline" };

describe("decideRecovery", () => {
  it("does nothing without a backup", () => {
    expect(decideRecovery(server, null)).toEqual({ kind: "none" });
  });

  it("does nothing when the backup matches the server", () => {
    expect(decideRecovery(server, { flow: { ...server, flow_id: "x" }, baseVersion: 1 })).toEqual({
      kind: "none",
    });
  });

  it("restores edits made on top of the current server version", () => {
    expect(decideRecovery(server, { flow: edited, baseVersion: 3 })).toEqual({
      kind: "restore",
      flow: edited,
    });
  });

  it.each([
    ["older base version", 2],
    ["unknown base version", null],
  ])("asks when the backup has an %s", (_name, baseVersion) => {
    expect(decideRecovery(server, { flow: edited, baseVersion })).toEqual({
      kind: "ask",
      flow: edited,
    });
  });
});
