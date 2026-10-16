import { describe, expect, it } from "vitest";

import { formatBytes, formatRelativeTime, plural } from "./format";

const now = new Date("2026-10-07T12:00:00Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

describe("formatRelativeTime", () => {
  it.each([
    [10, "just now"],
    [50, "1 minute ago"],
    [5 * 60, "5 minutes ago"],
    [2 * 3600, "2 hours ago"],
    [26 * 3600, "yesterday"],
    [3 * 86400, "3 days ago"],
    [15 * 86400, "2 weeks ago"],
    [400 * 86400, "last year"],
  ])("%i seconds ago → %s", (seconds, expected) => {
    expect(formatRelativeTime(ago(seconds), now)).toBe(expected);
  });

  it("accepts ISO strings", () => {
    expect(formatRelativeTime("2026-10-07T11:00:00Z", now)).toBe("1 hour ago");
  });
});

describe("plural", () => {
  it("pluralises", () => {
    expect(plural(1, "node")).toBe("1 node");
    expect(plural(3, "node")).toBe("3 nodes");
    expect(plural(0, "flow")).toBe("0 flows");
  });
});

describe("formatBytes", () => {
  it("uses the largest unit that fits, with one decimal below 10", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
    expect(formatBytes(10_485_760)).toBe("10 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3 GB");
  });
});
