import { describe, expect, it } from "vitest";

import { chunkSettingsProblem } from "./knowledge";

describe("chunkSettingsProblem", () => {
  it("accepts the backend's ranges and refuses everything else", () => {
    expect(chunkSettingsProblem(1000, 150)).toBeNull();
    expect(chunkSettingsProblem(200, 100)).toBeNull(); // overlap: at most half
    expect(chunkSettingsProblem(4000, 0)).toBeNull();
    expect(chunkSettingsProblem(199, 0)).toContain("Chunk size");
    expect(chunkSettingsProblem(4001, 0)).toContain("Chunk size");
    expect(chunkSettingsProblem(500.5, 0)).toContain("Chunk size");
    expect(chunkSettingsProblem(Number.NaN, 0)).toContain("Chunk size");
    expect(chunkSettingsProblem(1000, 501)).toContain("from 0 to 500");
    expect(chunkSettingsProblem(1000, -1)).toContain("Overlap");
  });
});
