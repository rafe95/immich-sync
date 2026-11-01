import { describe, expect, test } from "bun:test";
import { opBadgeClass, relativeIn, scheduleState } from "./jobCard.ts";
import type { ScheduleRecord } from "./jobs.ts";

const sched = (over: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  id: "s", jobId: "j", cron: "0 3 * * 0", timezone: "Europe/Madrid", enabled: true, catchUp: false, moveConfirmedAt: null, nextRuns: ["2030-01-06T02:00:00Z"], ...over,
});

describe("scheduleState", () => {
  test("no schedule", () => expect(scheduleState(null, true).kind).toBe("none"));
  test("active shows next runs and reads the cron", () => {
    const s = scheduleState(sched(), false);
    expect(s).toMatchObject({ kind: "active", what: "Every Sunday at 03:00", timezone: "Europe/Madrid", moveUnconfirmed: false });
    expect(s.next).toHaveLength(1);
  });
  test("paused hides next runs and never warns", () => {
    expect(scheduleState(sched({ enabled: false }), true)).toMatchObject({ kind: "paused", next: [], moveUnconfirmed: false });
  });
  test("an enabled move schedule without confirmation is flagged, a confirmed one is not", () => {
    expect(scheduleState(sched(), true).moveUnconfirmed).toBe(true);
    expect(scheduleState(sched({ moveConfirmedAt: "2030-01-01T00:00:00Z" }), true).moveUnconfirmed).toBe(false);
    expect(scheduleState(sched(), false).moveUnconfirmed).toBe(false);
  });
  test("custom cron falls back to the raw expression", () => expect(scheduleState(sched({ cron: "*/5 1 * * *" }), false).what).toBe("Cron */5 1 * * *"));
});

describe("relativeIn", () => {
  const now = new Date("2030-01-01T00:00:00Z");
  test("units", () => {
    expect(relativeIn("2030-01-01T00:12:00Z", now)).toBe("in 12 minutes");
    expect(relativeIn("2030-01-01T03:00:00Z", now)).toBe("in 3 hours");
    expect(relativeIn("2030-01-07T00:00:00Z", now)).toBe("in 6 days");
  });
  test("past and invalid are null", () => {
    expect(relativeIn("2029-12-31T00:00:00Z", now)).toBeNull();
    expect(relativeIn("nope", now)).toBeNull();
  });
});

test("operation badge classes", () => {
  expect(opBadgeClass("move")).toContain("warning");
  expect(opBadgeClass("copy")).toContain("primary");
  expect(opBadgeClass("sync_metadata")).toContain("tertiary");
});
