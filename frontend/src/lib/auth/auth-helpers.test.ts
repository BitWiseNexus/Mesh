import { describe, expect, it } from "vitest";

import { authErrorMessage, initials, safeRedirectPath } from "./auth-helpers";

describe("safeRedirectPath", () => {
  it.each([
    ["/flows/abc", "/flows/abc"],
    ["/flows/abc?tab=runs", "/flows/abc?tab=runs"],
    [null, "/flows"],
    ["", "/flows"],
    ["canvas", "/flows"],
    ["https://evil.example", "/flows"],
    ["//evil.example", "/flows"],
    ["/\\evil.example", "/flows"],
    ["/login", "/flows"],
    ["/login?next=/canvas", "/flows"],
  ])("%s → %s", (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });
});

describe("authErrorMessage", () => {
  it("maps known Firebase codes to friendly text", () => {
    expect(authErrorMessage({ code: "auth/invalid-credential" })).toBe(
      "Email or password is incorrect.",
    );
    expect(authErrorMessage({ code: "auth/email-already-in-use" })).toContain("already exists");
  });

  it("stays silent when the user closes the popup", () => {
    expect(authErrorMessage({ code: "auth/popup-closed-by-user" })).toBeNull();
  });

  it("falls back to a generic message", () => {
    expect(authErrorMessage(new Error("boom"))).toBe("Something went wrong. Please try again.");
  });
});

describe("initials", () => {
  it.each([
    ["Ada Lovelace", "ada@x.io", "AL"],
    ["Ada", null, "A"],
    [null, "grace.hopper@navy.mil", "G"],
    [null, null, "?"],
  ])("%s / %s → %s", (name, email, expected) => {
    expect(initials(name, email)).toBe(expected);
  });
});
