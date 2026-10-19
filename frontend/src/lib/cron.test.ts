import { describe, expect, it } from "vitest";

import cases from "../../../shared/cron-cases.json";
import { cronProblem } from "./cron";

describe("cronProblem (shared cases with the backend)", () => {
  it.each(cases.cases)("$expression", ({ expression, problem }) => {
    expect(cronProblem(expression)).toBe(problem);
  });
});
