import { describe, expect, test } from "bun:test";
import { memoryJobStore } from "../src/jobs/store.ts";
import type { JobStore } from "../src/jobs/store.ts";
import type { StepInput } from "../src/jobs/validation.ts";
import { memoryInstanceStore } from "../src/instances/store.ts";
import { createRunManager } from "../src/runs/manager.ts";
import { memoryRunStore } from "../src/runs/store.ts";
import { createScheduler, type Timers } from "../src/scheduler.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const OWNER = "99999999-9999-4999-8999-999999999999";

/** Manual clock: timers fire in order as time is advanced. */
function fakeTimers(start: string) {
  let now = new Date(start).getTime();
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => void pending.delete(h as number),
  };
  return {
    timers,
    pending: () => pending.size,
    async advanceTo(iso: string) {
      const target = new Date(iso).getTime();
      for (;;) {
        const next = [...pending].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
        for (let i = 0; i < 5; i++) await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
      }
      now = target;
    },
    /** Time passes with the process "down": timers do not fire. */
    jump(iso: string) {
      now = new Date(iso).getTime();
    },
  };
}

const step = (operation: StepInput["operation"] = "copy"): StepInput => ({
  operation, sourceId: A, targetId: B, onFailure: "continue", onError: "stop",
  options: { range: null, kind: "all", metadata: false, dryRun: false },
});

async function setup(start = "2026-03-01T08:00:00Z") {
  const clock = fakeTimers(start);
  const jobs: JobStore = memoryJobStore();
  const started: Array<{ jobId: string; ownerId: string; trigger: string; startedBy: string; dryRun: boolean }> = [];
  const logs: string[] = [];
  const skipped: Array<{ jobId: string; reason: string }> = [];
  const active = new Map<string, string>();
  let lastScheduled: Date | null = null;
  const scheduler = createScheduler({
    jobs,
    runs: {
      start: async (req: any) => {
        started.push({ jobId: req.job.id, ownerId: req.ownerId, trigger: req.trigger, startedBy: req.startedBy, dryRun: req.dryRun });
        return { id: `run-${started.length}` } as never;
      },
      activeRunForJob: (id: string) => active.get(id) ?? null,
      recordSkipped: async (jobId: string, reason: string) => {
        skipped.push({ jobId, reason });
        return {} as never;
      },
    },
    lastScheduledRunAt: async () => lastScheduled,
    timers: clock.timers,
    log: (_l, m) => void logs.push(m),
  });
  const mk = async (sched: Partial<{ cron: string; timezone: string; enabled: boolean; catchUp: boolean; moveConfirmedAt: Date | null }> = {}, steps = [step()]) => {
    const job = await jobs.create(OWNER, { name: "Nightly", steps });
    await jobs.upsertSchedule(OWNER, job.id, { cron: "0 9 * * *", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: null, ...sched });
    return job;
  };
  return { clock, jobs, scheduler, started, skipped, logs, active, mk, setLast: (d: Date | null) => (lastScheduled = d) };
}

describe("scheduler", () => {
  test("scheduler does not start a run for an owner being deleted", async () => {
    const clock = fakeTimers("2026-03-01T08:00:00Z");
    const jobs = memoryJobStore();
    const runs = memoryRunStore();
    const logs: string[] = [];
    const manager = createRunManager({
      store: runs, jobs, instances: memoryInstanceStore(), executor: { run: async () => { throw new Error("must not execute"); } } as never,
      owners: { isDeleting: async (id) => id === OWNER },
    });
    const scheduler = createScheduler({ jobs, runs: manager, timers: clock.timers, log: (_l, m) => void logs.push(m) });
    const job = await jobs.create(OWNER, { name: "Nightly", steps: [step()] });
    await jobs.upsertSchedule(OWNER, job.id, { cron: "0 9 * * *", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: null });
    await scheduler.start();
    await clock.advanceTo("2026-03-01T09:00:30Z");
    expect(logs.some((m) => m.includes("being deleted"))).toBe(true);
    expect((await runs.system.listRuns({ limit: 10, offset: 0 })).runs).toHaveLength(0); // not even a skipped record
    scheduler.stop();
  });

  test("fires at the next occurrence in the schedule's time zone, as a schedule-triggered run", async () => {
    const t = await setup("2026-03-01T00:00:00Z");
    const job = await t.mk({ cron: "0 9 * * *", timezone: "Asia/Tokyo" }); // 09:00 JST = 00:00 UTC
    await t.scheduler.start();
    await t.clock.advanceTo("2026-03-01T23:59:00Z");
    expect(t.started).toHaveLength(0);
    await t.clock.advanceTo("2026-03-02T00:00:30Z");
    expect(t.started).toEqual([{ jobId: job.id, ownerId: OWNER, trigger: "schedule", startedBy: "schedule", dryRun: false }]);
    await t.clock.advanceTo("2026-03-03T00:00:30Z");
    expect(t.started).toHaveLength(2);
    t.scheduler.stop();
  });

  test("scheduled run carries the job owner", async () => {
    const t = await setup("2026-03-01T08:00:00Z");
    const job = await t.mk();
    await t.scheduler.start();
    await t.clock.advanceTo("2026-03-01T09:00:30Z");
    expect(t.started).toHaveLength(1);
    expect(t.started[0]).toMatchObject({ jobId: job.id, ownerId: OWNER });
    t.scheduler.stop();
  });

  test("paused schedules never fire", async () => {
    const t = await setup();
    await t.mk({ enabled: false });
    await t.scheduler.start();
    expect(t.scheduler.armedCount()).toBe(0);
    await t.clock.advanceTo("2026-03-05T00:00:00Z");
    expect(t.started).toHaveLength(0);
    t.scheduler.stop();
  });

  test("a firing while the previous run is active is skipped and logged", async () => {
    const t = await setup();
    const job = await t.mk();
    await t.scheduler.start();
    t.active.set(job.id, "run-x");
    await t.clock.advanceTo("2026-03-01T09:00:30Z");
    expect(t.started).toHaveLength(0);
    expect(t.logs.join("\n")).toContain("still queued or running");
    expect(t.skipped).toEqual([{ jobId: job.id, reason: "skipped: previous run still active" }]);
    t.active.clear();
    await t.clock.advanceTo("2026-03-02T09:00:30Z");
    expect(t.started).toHaveLength(1);
    t.scheduler.stop();
  });

  test("a move job fires only with a move confirmation", async () => {
    const t = await setup();
    const job = await t.mk({}, [step("move")]);
    await t.scheduler.start();
    await t.clock.advanceTo("2026-03-01T09:00:30Z");
    expect(t.started).toHaveLength(0);
    expect(t.logs.join("\n")).toContain("no move confirmation");
    expect(t.skipped).toHaveLength(1);
    expect(t.skipped[0]!.reason).toContain("move confirmation");
    await t.jobs.upsertSchedule(OWNER, job.id, { cron: "0 9 * * *", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: new Date("2026-03-01T10:00:00Z") });
    await t.scheduler.reload();
    await t.clock.advanceTo("2026-03-02T09:00:30Z");
    expect(t.started).toHaveLength(1);
    t.scheduler.stop();
  });

  test("missed runs are not caught up by default", async () => {
    const t = await setup("2026-03-01T08:00:00Z");
    await t.mk({ catchUp: false });
    t.clock.jump("2026-03-01T12:00:00Z"); // 09:00 passed while "down"; schedule created at real now, so use setLast
    t.setLast(new Date("2026-02-28T09:00:00Z"));
    await t.scheduler.start();
    expect(t.started).toHaveLength(0);
    t.scheduler.stop();
  });

  test("catch_up runs once for missed occurrences, and not when already run", async () => {
    const t = await setup("2026-03-01T08:00:00Z");
    await t.mk({ catchUp: true });
    // schedule.updatedAt is the real wall clock (later than the fake clock): move the fake clock well past it.
    t.clock.jump("2099-01-01T12:00:00Z");
    t.setLast(new Date("2098-12-01T09:00:00Z"));
    await t.scheduler.start();
    expect(t.started).toHaveLength(1);
    expect(t.logs.join("\n")).toContain("catch-up");
    t.scheduler.stop();

    // Last scheduled run was after the most recent occurrence: nothing to catch up.
    const again = await setup();
    await again.mk({ catchUp: true });
    again.clock.jump("2099-01-01T12:00:00Z");
    again.setLast(new Date("2099-01-01T09:00:05Z"));
    await again.scheduler.start();
    expect(again.started).toHaveLength(0);
    again.scheduler.stop();
  });

  test("reload picks up created, changed and deleted schedules without a restart; stop clears timers", async () => {
    const t = await setup();
    await t.scheduler.reload(); // not started: no-op
    expect(t.scheduler.armedCount()).toBe(0);
    await t.scheduler.start();
    expect(t.scheduler.armedCount()).toBe(0);

    const job = await t.mk({ cron: "0 9 * * *" });
    await t.scheduler.reload();
    expect(t.scheduler.armedCount()).toBe(1);

    await t.jobs.upsertSchedule(OWNER, job.id, { cron: "0 12 * * *", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: null });
    await t.scheduler.reload();
    expect(t.scheduler.armedCount()).toBe(1);
    await t.clock.advanceTo("2026-03-01T09:30:00Z");
    expect(t.started).toHaveLength(0);
    await t.clock.advanceTo("2026-03-01T12:00:30Z");
    expect(t.started).toHaveLength(1);

    await t.jobs.deleteSchedule(OWNER, job.id);
    await t.scheduler.reload();
    expect(t.scheduler.armedCount()).toBe(0);
    await t.clock.advanceTo("2026-03-03T00:00:00Z");
    expect(t.started).toHaveLength(1);

    await t.mk();
    await t.scheduler.reload();
    expect(t.scheduler.armedCount()).toBe(1);
    t.scheduler.stop();
    expect(t.scheduler.armedCount()).toBe(0);
    expect(t.clock.pending()).toBe(0);
    await t.clock.advanceTo("2026-03-10T00:00:00Z");
    expect(t.started).toHaveLength(1);
  });
});
