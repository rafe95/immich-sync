import { expect, test } from "bun:test";
import {
  buildJobBody, buildScheduleBody, cronFromForm, defaultScheduleForm, defaultStep, describeCron, filterTimezones, formFromSchedule, moveItem, needsMoveConfirmation,
  jobSnapshot, normalizeStepForm, scheduleSummary, stepFromRecord, stepSummary, validateJob, validateScheduleForm,
} from "./jobs.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const step = (over = {}) => defaultStep({ sourceId: A, targetId: B, ...over });

test("step rules: same instance, window, lastDays, trash for move, album dependencies", () => {
  expect(validateJob("n", [step({ targetId: A })]).join()).toContain("must be different");
  expect(validateJob("n", [step({ rangeMode: "window" })]).join()).toContain("from date, a to date, or both");
  expect(validateJob("n", [step({ rangeMode: "window", from: "2024-02-01", to: "2024-01-01" })].map((s) => s)).join()).toContain("must not be after");
  expect(validateJob("n", [step({ rangeMode: "window", to: "2024-01-01" })])).toEqual([]);
  expect(validateJob("n", [step({ rangeMode: "lastDays", lastDays: "0" })]).join()).toContain("last N days");
  expect(validateJob("n", [step({ rangeMode: "lastDays", lastDays: "7" })])).toEqual([]);
  expect(validateJob("n", [step({ operation: "move", includeTrashed: true })]).join()).toContain("not supported for a move");
  expect(validateJob("n", [step({ includeAlbums: false, createMissingAlbums: true })]).join()).toContain("requires album sync");
  expect(validateJob("n", [step({ metadata: false, includeTags: true })]).join()).toContain("need metadata");
  expect(validateJob("n", [step({ metadata: false, includeEdits: true })]).join()).toContain("need metadata");
  expect(validateJob(" ", [])).toHaveLength(2);
});

test("normalizeStepForm restores dependent options", () => {
  expect(normalizeStepForm(step({ metadata: false, includeAlbums: true, includeTags: true, includeEdits: true, createMissingAlbums: true }))).toMatchObject({ includeAlbums: false, includeTags: false, includeEdits: false, createMissingAlbums: false });
  expect(normalizeStepForm(step({ includeAlbums: false, createMissingAlbums: true })).createMissingAlbums).toBe(false);
  expect(normalizeStepForm(step({ operation: "sync_metadata", metadata: false })).metadata).toBe(true);
  expect(normalizeStepForm(step({ operation: "move", includeTrashed: true })).includeTrashed).toBe(false);
});

test("job body: ranges, optional keys and failure options", () => {
  const r = buildJobBody(" Nightly ", [
    step({ rangeMode: "lastDays", lastDays: "14", includeAlbums: true, createMissingAlbums: true, includeTags: true, includeTrashed: true, onFailure: "stop", onError: "continue" }),
    step({ operation: "move", rangeMode: "window", from: "2024-01-01" }),
  ]);
  if (!r.ok) throw new Error(r.problems.join());
  expect(r.body.name).toBe("Nightly");
  expect(r.body.steps[0]).toEqual({
    operation: "copy", sourceId: A, targetId: B, onFailure: "stop", onError: "continue",
    options: { range: { lastDays: 14 }, kind: "all", metadata: true, includeAlbums: true, createMissingAlbums: true, includeTags: true, includeTrashed: true },
  });
  expect((r.body.steps[1] as any).options).toEqual({ range: { from: "2024-01-01" }, kind: "all", metadata: true });
  expect(buildJobBody("x", []).ok).toBe(false);
});

test("stepFromRecord round-trips and tolerates old records", () => {
  const f = stepFromRecord({ operation: "copy", sourceId: A, targetId: B, options: { range: { from: "2024-01-01", to: "2024-02-01" }, kind: "photos", metadata: true }, onFailure: "stop", onError: "stop" });
  expect(f).toMatchObject({ rangeMode: "window", from: "2024-01-01", to: "2024-02-01", kind: "photos", includeAlbums: false });
  expect(stepFromRecord({ operation: "copy", sourceId: A, targetId: B, options: { range: { lastDays: 3 } } } as any)).toMatchObject({ rangeMode: "lastDays", lastDays: "3" });
});

test("reorder and summary", () => {
  expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
  expect(moveItem([1, 2, 3], 1, 5)).toEqual([1, 2, 3]);
  const names: Record<string, string> = { [A]: "A", [B]: "B" };
  expect(stepSummary(step({ kind: "photos" }), (id) => names[id]!)).toBe("Copy · A → B · photos only · metadata on");
});

test("cron presets build and parse back", () => {
  const f = defaultScheduleForm("UTC");
  expect(cronFromForm({ ...f, preset: "daily", time: "00:30" })).toBe("30 0 * * *");
  expect(cronFromForm({ ...f, preset: "hourly", minute: 15 })).toBe("15 * * * *");
  expect(cronFromForm({ ...f, preset: "weekly", time: "07:05", days: [5, 1, 1] })).toBe("5 7 * * 1,5");
  expect(cronFromForm({ ...f, preset: "weekly", days: [] })).toBeNull();
  expect(cronFromForm({ ...f, preset: "daily", time: "25:00" })).toBeNull();
  expect(cronFromForm({ ...f, preset: "custom", custom: "  */5  * * * * " })).toBe("*/5 * * * *");
  expect(formFromSchedule({ cron: "30 0 * * *", timezone: "UTC", enabled: true, catchUp: false })).toMatchObject({ preset: "daily", time: "00:30" });
  expect(formFromSchedule({ cron: "5 7 * * 1,5", timezone: "UTC", enabled: true, catchUp: false })).toMatchObject({ preset: "weekly", days: [1, 5] });
  expect(formFromSchedule({ cron: "*/5 * * * *", timezone: "UTC", enabled: true, catchUp: false }).preset).toBe("custom");
  expect(describeCron("30 0 * * *")).toBe("Every day at 00:30");
  expect(describeCron("*/5 * * * *")).toBeNull();
});

test("schedule validation and body", () => {
  const f = { ...defaultScheduleForm("Europe/Lisbon"), preset: "custom" as const, custom: "* * *" };
  expect(validateScheduleForm(f).join()).toContain("five fields");
  expect(validateScheduleForm({ ...f, custom: "0 1 * * *", timezone: "Nope/Zone" }).join()).toContain("time zone");
  const ok = buildScheduleBody({ ...f, custom: "0 1 * * *", catchUp: true }, true);
  expect(ok).toEqual({ ok: true, body: { cron: "0 1 * * *", timezone: "Europe/Lisbon", enabled: true, catchUp: true, confirmMove: true } });
  expect(needsMoveConfirmation([{ operation: "move" }], true)).toBe(true);
  expect(needsMoveConfirmation([{ operation: "move" }], false)).toBe(false);
  expect(needsMoveConfirmation([{ operation: "copy" }], true)).toBe(false);
});

test("timezone filter and schedule summary", () => {
  expect(filterTimezones(["Europe/Lisbon", "America/New_York"], "new york")).toEqual(["America/New_York"]);
  expect(scheduleSummary(null)).toBe("No schedule");
  expect(scheduleSummary({ cron: "30 0 * * *", timezone: "UTC", enabled: false } as any)).toBe("Every day at 00:30 (UTC) · paused");
});

test("jobSnapshot follows what would be saved, ignores client-only keys, and still tells invalid forms apart", () => {
  const a = defaultStep({ sourceId: "s", targetId: "t" });
  expect(jobSnapshot("J", [a])).toBe(jobSnapshot("J", [{ ...a, key: "another-client-key" }]));
  expect(jobSnapshot("J", [a])).not.toBe(jobSnapshot("K", [a]));
  expect(jobSnapshot("J", [a])).not.toBe(jobSnapshot("J", [{ ...a, kind: "photos" }]));
  expect(jobSnapshot("J", [a])).not.toBe(jobSnapshot("J", [a, defaultStep({ sourceId: "t", targetId: "s" })]));

  // No target yet: the form cannot be saved, but editing it must still count as a change.
  const incomplete = defaultStep({ sourceId: "s", targetId: "" });
  expect(jobSnapshot("J", [incomplete])).toBe(jobSnapshot("J", [{ ...incomplete, key: "x" }]));
  expect(jobSnapshot("J", [incomplete])).not.toBe(jobSnapshot("J2", [incomplete]));
  expect(jobSnapshot("J", [incomplete])).not.toBe(jobSnapshot("J", [{ ...incomplete, kind: "videos" }]));
});
