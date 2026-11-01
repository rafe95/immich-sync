import { describe, expect, test } from "bun:test";
import type { InstanceCheck } from "./api.ts";
import type { JobRecord } from "./jobs.ts";
import { checkSummary, firstInstanceIsDefault, inUse, jobsUsing, stageState } from "./instances.ts";

const check = (over: Partial<InstanceCheck> = {}): InstanceCheck => ({
  alias: "a",
  ok: true,
  checkedAt: "2026-11-01T00:00:00Z",
  latencyMs: 12,
  version: "3.3.5",
  versionStatus: "supported",
  user: null,
  permissions: [],
  roles: null,
  error: null,
  warnings: [],
  ...over,
});

const step = (sourceId: string, targetId: string) => ({ operation: "copy", sourceId, targetId, options: {}, onFailure: "stop", onError: "stop" }) as unknown as JobRecord["steps"][number];
const job = (id: string, steps: JobRecord["steps"]): JobRecord => ({ id, name: id, hasMove: false, steps, schedule: null, createdAt: "", updatedAt: "" });

describe("stageState", () => {
  test("every stage is ok when the check has no error", () => {
    for (const s of ["ping", "version", "key", "permissions"] as const) expect(stageState(check(), s)).toBe("ok");
  });
  test("stages before the failure are ok, the failed one is failed, later ones were not run", () => {
    const c = check({ ok: false, error: { stage: "key", message: "rejected" } });
    expect(stageState(c, "ping")).toBe("ok");
    expect(stageState(c, "version")).toBe("ok");
    expect(stageState(c, "key")).toBe("failed");
    expect(stageState(c, "permissions")).toBe("not run");
  });
});

describe("checkSummary", () => {
  test("no check yet", () => expect(checkSummary(null)).toEqual({ label: "Not checked", tone: "surface" }));
  test("failed check", () => expect(checkSummary(check({ ok: false }))).toEqual({ label: "Failed", tone: "error" }));
  test("warnings", () => expect(checkSummary(check({ warnings: ["w"] }))).toEqual({ label: "OK, with warnings", tone: "warning" }));
  test("clean check", () => expect(checkSummary(check())).toEqual({ label: "OK", tone: "success" }));
});

describe("jobsUsing", () => {
  const jobs = [job("j1", [step("a", "b"), step("b", "c")]), job("j2", [step("c", "a")]), job("j3", [step("x", "y")])];
  test("lists each job once with the role the instance plays", () => {
    const uses = jobsUsing("b", jobs);
    expect(uses.map((u) => u.job.id)).toEqual(["j1"]);
    expect(uses[0]).toMatchObject({ asSource: true, asTarget: true });
  });
  test("source-only and target-only roles", () => {
    expect(jobsUsing("a", jobs).map((u) => [u.job.id, u.asSource, u.asTarget])).toEqual([
      ["j1", true, false],
      ["j2", false, true],
    ]);
  });
  test("an instance no job uses", () => {
    expect(jobsUsing("unused", jobs)).toEqual([]);
    expect(inUse("unused", jobs)).toBe(false);
    expect(inUse("x", jobs)).toBe(true);
  });
});

describe("firstInstanceIsDefault", () => {
  test("only when there are no instances yet", () => {
    expect(firstInstanceIsDefault([])).toBe(true);
    expect(firstInstanceIsDefault([{ id: "a" }])).toBe(false);
  });
});
