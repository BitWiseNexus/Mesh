import { describe, expect, it } from "vitest";

import { formatRelativeTime, plural } from "./format";

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
