import { describe, expect, it } from "vitest";

import { chunkSettingsProblem, MAX_DOCUMENT_BYTES, uploadProblem } from "./knowledge";

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

describe("uploadProblem", () => {
  it("lets through what the backend accepts, and explains the rest", () => {
    for (const name of ["a.pdf", "b.TXT", "c.md", "d.markdown", "e.text"]) {
      expect(uploadProblem({ name, size: 10 })).toBeNull();
    }
    expect(uploadProblem({ name: "photo.png", size: 10 })).toContain("upload PDF");
    expect(uploadProblem({ name: "README", size: 10 })).toContain("upload PDF");
    expect(uploadProblem({ name: "a.md", size: 0 })).toContain("is empty");
    expect(uploadProblem({ name: "a.md", size: MAX_DOCUMENT_BYTES })).toBeNull();
    expect(uploadProblem({ name: "a.md", size: MAX_DOCUMENT_BYTES + 1 })).toContain("10 MB");
  });
});
