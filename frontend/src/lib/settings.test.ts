import { describe, expect, test } from "bun:test";
import { parseRetentionDays, passwordProblems } from "./settings.ts";

describe("passwordProblems", () => {
  const ok = { current: "old password here", next: "a brand new passphrase", confirm: "a brand new passphrase" };
  test("valid form has no problems", () => expect(passwordProblems(ok)).toEqual([]));
  test("requires current, length, difference and matching confirmation", () => {
    expect(passwordProblems({ ...ok, current: "" })).toHaveLength(1);
    expect(passwordProblems({ ...ok, next: "short", confirm: "short" })[0]).toContain("at least 12");
    expect(passwordProblems({ current: "same password!", next: "same password!", confirm: "same password!" })[0]).toContain("differ");
    expect(passwordProblems({ ...ok, confirm: "other" })[0]).toContain("does not match");
    expect(passwordProblems({ ...ok, next: "x".repeat(257), confirm: "x".repeat(257) })[0]).toContain("at most 256");
  });
});

describe("parseRetentionDays", () => {
  test("accepts whole numbers in range", () => {
    expect(parseRetentionDays(" 90 ")).toEqual({ days: 90 });
    expect(parseRetentionDays("1")).toEqual({ days: 1 });
    expect(parseRetentionDays("3650")).toEqual({ days: 3650 });
  });
  test("rejects empty, fractional, negative and out-of-range", () => {
    for (const t of ["", "1.5", "-3", "abc", "0", "3651"]) expect("error" in parseRetentionDays(t)).toBe(true);
  });
});
