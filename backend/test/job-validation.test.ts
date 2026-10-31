import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/http.ts";
import { nextRuns, validateJobInput, validateScheduleInput } from "../src/jobs/validation.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const step = (over: Record<string, unknown> = {}) => ({ operation: "copy", sourceId: A, targetId: B, ...over });
const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return (e.extra.problems as string[]) ?? [];
    throw e;
  }
  return [];
};
const job = (steps: unknown[], name: unknown = "Nightly") => ({ name, steps });

describe("job validation", () => {
  test("defaults are filled in", () => {
    const out = validateJobInput(job([step()]));
    expect(out.name).toBe("Nightly");
    expect(out.steps![0]).toEqual({
      operation: "copy", sourceId: A, targetId: B, onFailure: "continue", onError: "stop",
      options: { range: null, kind: "all", metadata: true, includeAlbums: false, createMissingAlbums: false, includeTags: false, dryRun: false },
    });
  });

  test("rejects same source and target, bad operation, bad ids, empty steps and bad names", () => {
    expect(problemsOf(() => validateJobInput(job([step({ targetId: A })]))).join()).toContain("different");
    expect(problemsOf(() => validateJobInput(job([step({ operation: "delete" })]))).join()).toContain("operation");
    expect(problemsOf(() => validateJobInput(job([step({ sourceId: "x" })]))).join()).toContain("sourceId");
    expect(problemsOf(() => validateJobInput(job([]))).join()).toContain("steps");
    expect(problemsOf(() => validateJobInput(job([step()], "  "))).join()).toContain("name");
    expect(problemsOf(() => validateJobInput(job([step()], "x".repeat(101)))).join()).toContain("name");
  });

  test("on_failure and on_error values", () => {
    expect(validateJobInput(job([step({ onFailure: "stop", onError: "continue" })])).steps![0]).toMatchObject({ onFailure: "stop", onError: "continue" });
    expect(problemsOf(() => validateJobInput(job([step({ onFailure: "abort" })]))).join()).toContain("onFailure");
    expect(problemsOf(() => validateJobInput(job([step({ onError: "ignore" })]))).join()).toContain("onError");
  });

  test("range: either end may be left out, but not both; from must not follow to; lastDays is exclusive", () => {
    const opt = (options: unknown) => () => validateJobInput(job([step({ options })]));
    expect(validateJobInput(job([step({ options: { range: { from: "2024-01-01", to: "2024-02-01" } } })])).steps![0]!.options.range).toEqual({ from: "2024-01-01", to: "2024-02-01" });
    expect(validateJobInput(job([step({ options: { range: { to: "2024-02-01T00:00:00Z" } } })])).steps![0]!.options.range).toEqual({ to: "2024-02-01T00:00:00Z" });
    expect(validateJobInput(job([step({ options: { range: { lastDays: 30 } } })])).steps![0]!.options.range).toEqual({ lastDays: 30 });
    expect(validateJobInput(job([step({ options: { range: { from: "2024-01-01" } } })])).steps![0]!.options.range).toEqual({ from: "2024-01-01" });
    expect(validateJobInput(job([step({ options: { range: { from: "2024-01-01", to: "" } } })])).steps![0]!.options.range).toEqual({ from: "2024-01-01" });
    expect(problemsOf(opt({ range: {} })).join()).toContain("needs a from date, a to date, or both");
    expect(validateJobInput(job([step({ options: { includeTrashed: true } })])).steps![0]!.options.includeTrashed).toBe(true);
    expect(problemsOf(opt({ includeTrashed: "yes" })).join()).toContain("includeTrashed must be a boolean");
    expect(problemsOf(() => validateJobInput(job([step({ operation: "move", options: { includeTrashed: true } })]))).join()).toContain("not supported for a move");
    expect(problemsOf(opt({ range: { from: "2024-03-01", to: "2024-02-01" } })).join()).toContain("after");
    expect(problemsOf(opt({ range: { from: "nope", to: "2024-02-01" } })).join()).toContain("ISO date");
    expect(problemsOf(opt({ range: { lastDays: 0 } })).join()).toContain("lastDays");
    expect(problemsOf(opt({ range: { lastDays: 3, to: "2024-01-01" } })).join()).toContain("combined");
  });

  test("album and tag options need metadata; createMissingAlbums needs includeAlbums", () => {
    const opt = (o: unknown, op = "copy") => () => validateJobInput(job([step({ operation: op, options: o })]));
    expect(validateJobInput(job([step({ options: { includeAlbums: true, createMissingAlbums: true, includeTags: true } })])).steps![0]!.options)
      .toMatchObject({ includeAlbums: true, createMissingAlbums: true, includeTags: true });
    expect(problemsOf(opt({ metadata: false, includeTags: true })).join()).toContain("metadata");
    expect(problemsOf(opt({ createMissingAlbums: true })).join()).toContain("requires includeAlbums");
    expect(problemsOf(opt({ includeAlbums: "yes" })).join()).toContain("includeAlbums must be a boolean");
  });

  test("kind, metadata, dryRun and unknown option keys", () => {
    const opt = (options: unknown, operation = "copy") => () => validateJobInput(job([step({ operation, options })]));
    expect(validateJobInput(job([step({ options: { kind: "videos", metadata: false, dryRun: true } })])).steps![0]!.options).toMatchObject({ kind: "videos", metadata: false, dryRun: true });
    expect(problemsOf(opt({ kind: "raw" })).join()).toContain("kind");
    expect(problemsOf(opt({ metadata: "yes" })).join()).toContain("metadata");
    expect(problemsOf(opt({ dryRun: 1 })).join()).toContain("dryRun");
    expect(problemsOf(opt({ metadata: false }, "sync_metadata")).join()).toContain("sync_metadata");
    expect(problemsOf(opt({ force: true })).join()).toContain("unknown option");
    expect(problemsOf(opt([])).join()).toContain("object");
  });

  test("partial updates only validate the given fields", () => {
    expect(validateJobInput({ name: "New" }, { partial: true })).toEqual({ name: "New" });
    expect(problemsOf(() => validateJobInput({ steps: [] }, { partial: true })).length).toBe(1);
  });
});

describe("schedule validation", () => {
  const ok = { cron: "30 0 * * *", timezone: "Europe/Lisbon" };
  test("accepts a cron and an IANA time zone, applies defaults", () => {
    expect(validateScheduleInput(ok, { timezone: "UTC" })).toEqual({ ...ok, enabled: true, catchUp: false, confirmMove: false });
    expect(validateScheduleInput({ cron: "*/15  * * * 1-5" }, { timezone: "UTC" })).toMatchObject({ cron: "*/15 * * * 1-5", timezone: "UTC" });
  });
  test("rejects bad cron, bad time zone, seconds field and unknown fields", () => {
    const bad = (b: Record<string, unknown>) => problemsOf(() => validateScheduleInput(b, { timezone: "UTC" })).join();
    expect(bad({ ...ok, cron: "61 * * * *" })).toContain("cron");
    expect(bad({ ...ok, cron: "0 30 0 * * *" })).toContain("five fields");
    expect(bad({ ...ok, cron: 5 })).toContain("cron");
    expect(bad({ ...ok, timezone: "Mars/Base" })).toContain("time zone");
    expect(bad({ ...ok, enabled: "yes" })).toContain("enabled");
    expect(bad({ ...ok, extra: 1 })).toContain("Unknown");
  });
  test("next runs honour the time zone", () => {
    const from = new Date("2026-01-01T12:00:00Z");
    expect(nextRuns("0 9 * * *", "Asia/Tokyo", 2, from)).toEqual(["2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"]);
    expect(nextRuns("0 9 * * *", "UTC", 1, from)).toEqual(["2026-01-02T09:00:00.000Z"]);
  });
});
