import { expect, test } from "bun:test";
import type { Instance } from "../api.ts";
import { defaultStep, type ScheduleRecord } from "../jobs.ts";
import { buildPipeline, dropIndex, reorderByY, scheduleWarning, stepProblems } from "./pipeline.ts";

const inst = (id: string, versionStatus: "supported" | "unsupported" | null = null): Instance =>
  ({
    id, alias: id.toUpperCase(), apiUrl: "", note: null, isDefault: false, lastCheckedAt: null, createdAt: "", updatedAt: "",
    lastCheck: versionStatus ? { ok: true, versionStatus } : null,
  }) as unknown as Instance;
const sched = (over: Partial<ScheduleRecord> = {}): ScheduleRecord => ({ id: "s", jobId: "j", cron: "0 3 * * *", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: null, nextRuns: [], ...over });
const step = (over = {}) => defaultStep({ sourceId: "a", targetId: "b", ...over });
const build = (steps: ReturnType<typeof step>[], schedule: ScheduleRecord | null = null, selectedKey: string | null = null) =>
  buildPipeline({ steps, schedule, instances: [inst("a"), inst("b")], selectedKey });

test("zero steps renders only the add node and no schedule node without a schedule", () => {
  const { nodes, edges } = build([]);
  expect(nodes.map((n) => n.id)).toEqual(["add"]);
  expect(edges).toEqual([]);
});

test("zero steps with a schedule shows schedule and add, no edge", () => {
  const { nodes, edges } = build([], sched());
  expect(nodes.map((n) => n.id)).toEqual(["schedule", "add"]);
  expect(edges).toEqual([]);
});

test("steps stack vertically after the schedule, add node last", () => {
  const steps = [step(), step()];
  const { nodes } = build(steps, sched(), steps[1]!.key);
  expect(nodes.map((n) => n.id)).toEqual(["schedule", steps[0]!.key, steps[1]!.key, "add"]);
  expect(nodes.map((n) => n.position.y)).toEqual([0, 200, 400, 600]);
  expect(nodes.find((n) => n.id === steps[1]!.key)!.selected).toBe(true);
});

test("failure edge labels use exact strings and the on-error icon only when policies differ", () => {
  const steps = [step({ onFailure: "stop", onError: "stop" }), step({ onFailure: "continue", onError: "stop" }), step()];
  const { edges } = build(steps);
  expect(edges.map((e) => e.data!.label)).toEqual(["on failure · stop job", "on failure · continue"]);
  expect(edges[0]!.data!.icon).toBeUndefined();
  expect(edges[1]!.data!.icon).toBe("on-error");
});

test("unsupported instance versions are reported as problems", () => {
  const p = stepProblems(step({ targetId: "b" }), 0, [inst("a"), inst("b", "unsupported")]);
  expect(p).toContain("B runs an unsupported Immich version");
  expect(stepProblems(step(), 0, [inst("a"), inst("b", "supported")])).toEqual([]);
});

test("schedule warning for an unconfirmed enabled move", () => {
  const move = [step({ operation: "move" })];
  expect(scheduleWarning(sched(), move)).toBe("Scheduled move not confirmed");
  expect(scheduleWarning(sched({ moveConfirmedAt: "2026-01-01T00:00:00Z" }), move)).toBeNull();
  expect(scheduleWarning(sched({ enabled: false }), move)).toBeNull();
  expect(scheduleWarning(null, move)).toBeNull();
  expect(scheduleWarning(sched(), [step()])).toBeNull();
});

test("schedule node carries cron and time zone; all-asset steps get an 'all assets' chip", () => {
  const { nodes } = build([step()], sched({ cron: "0 3 * * 0", timezone: "Europe/Madrid" }));
  expect(nodes[0]!.data).toMatchObject({ cron: "0 3 * * 0", timezone: "Europe/Madrid" });
  expect((nodes[1]!.data as { chips: string[] }).chips).toContain("all assets");
});

test("dropIndex rounds to the nearest gap and clamps", () => {
  expect(dropIndex(-500, 3)).toBe(0);
  expect(dropIndex(80, 3)).toBe(0);
  expect(dropIndex(100, 3)).toBe(1);
  expect(dropIndex(9999, 3)).toBe(3);
});

test("reorderByY moves step 0 below step 1", () => {
  const steps = [step(), step()];
  expect(reorderByY(steps, steps[0]!.key, 200).map((s) => s.key)).toEqual([steps[1]!.key, steps[0]!.key]);
  expect(reorderByY(steps, "missing", 200).map((s) => s.key)).toEqual(steps.map((s) => s.key));
});
