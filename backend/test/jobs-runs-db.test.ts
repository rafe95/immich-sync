/** PostgreSQL-backed job and run stores; runs only when TEST_DATABASE_URL is set. Uses a throwaway schema. */
import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate } from "../src/db/migrate.ts";
import { pgInstanceStore } from "../src/instances/store.ts";
import { hashPassword } from "../src/auth/auth.ts";
import { pgUserStore } from "../src/auth/users.ts";
import { pgJobStore } from "../src/jobs/store.ts";
import type { StepInput } from "../src/jobs/validation.ts";
import { createRunManager } from "../src/runs/manager.ts";
import { pgRunStore, pruneHistory } from "../src/runs/store.ts";
import { FakeExecutor } from "./fake-executor.ts";

const url = process.env.TEST_DATABASE_URL;
const schema = `test_jobs_${Date.now()}`;
const sql = url ? new SQL(`${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`) : null;

afterAll(async () => {
  if (!sql) return;
  await sql.unsafe(`drop schema if exists ${schema} cascade`);
  await sql.close();
});

const step = (operation: StepInput["operation"], sourceId: string, targetId: string, over: Partial<StepInput> = {}): StepInput => ({
  operation, sourceId, targetId, onFailure: "continue", onError: "stop", options: { range: { lastDays: 7 }, kind: "photos", metadata: true, dryRun: false }, ...over,
});

describe.skipIf(!url)("jobs and runs (PostgreSQL)", () => {
  let A = "", B = "", C = "", OWNER = "", OTHER = "";

  test("setup: schema and instances", async () => {
    await sql!.unsafe(`create schema ${schema}`);
    await migrate(sql!);
    const users = pgUserStore(sql!);
    const hash = await hashPassword("a long enough password");
    OWNER = (await users.create("owner", hash, "admin")).id;
    OTHER = (await users.create("other", hash, "user")).id;
    const inst = pgInstanceStore(sql!);
    const mk = async (alias: string) => (await inst.create({ alias, apiUrl: `http://${alias}/api`, apiKeyEnc: Buffer.from("k"), note: null, isDefault: false })).id;
    [A, B, C] = [await mk("a"), await mk("b"), await mk("c")];
  });

  test("job store: create with ordered steps, replace steps, schedule upsert, revoke, cascade delete", async () => {
    const jobs = pgJobStore(sql!);
    const job = await jobs.create(OWNER, { name: "Spread", steps: [step("copy", A, B), step("move", B, C, { onFailure: "stop", onError: "continue" })] });
    expect(job.steps.map((s) => [s.position, s.operation, s.onFailure, s.onError])).toEqual([[1, "copy", "continue", "stop"], [2, "move", "stop", "continue"]]);
    expect(job.steps[0]!.options).toEqual({ range: { lastDays: 7 }, kind: "photos", metadata: true, dryRun: false });

    const updated = await jobs.update(OWNER, job.id, { name: "Spread 2", steps: [step("sync_metadata", C, A)] });
    expect(updated!.name).toBe("Spread 2");
    expect(updated!.steps.map((s) => s.operation)).toEqual(["sync_metadata"]);
    expect(await jobs.update(OWNER, crypto.randomUUID(), { name: "x" })).toBeNull();

    const when = new Date();
    const s1 = (await jobs.upsertSchedule(OWNER, job.id, { cron: "30 0 * * *", timezone: "Europe/Lisbon", enabled: true, catchUp: true, moveConfirmedAt: when }))!;
    expect(s1).toMatchObject({ cron: "30 0 * * *", timezone: "Europe/Lisbon", catchUp: true, moveConfirmedAt: when.toISOString() });
    const s2 = (await jobs.upsertSchedule(OWNER, job.id, { cron: "0 1 * * *", timezone: "UTC", enabled: false, catchUp: false, moveConfirmedAt: null }))!;
    expect(s2.id).toBe(s1.id);
    expect((await jobs.get(OWNER, job.id))!.schedule).toMatchObject({ cron: "0 1 * * *", enabled: false });
    await jobs.upsertSchedule(OWNER, job.id, { cron: "0 1 * * *", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: when });
    await jobs.revokeMoveConfirmation(OWNER, job.id);
    expect((await jobs.get(OWNER, job.id))!.schedule).toMatchObject({ moveConfirmedAt: null, enabled: false });
    expect(await jobs.upsertSchedule(OWNER, crypto.randomUUID(), { cron: "0 1 * * *", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: null })).toBeNull();

    expect((await jobs.list(OWNER)).length).toBeGreaterThanOrEqual(1);
    expect(await jobs.delete(OWNER, job.id)).toBe(true);
    expect(await jobs.listSchedules(OWNER)).toEqual([]);
    expect(await jobs.delete(OWNER, job.id)).toBe(false);
  });

  test("job store filters by owner", async () => {
    const jobs = pgJobStore(sql!);
    const job = await jobs.create(OWNER, { name: "Private", steps: [step("copy", A, B)] });
    await jobs.upsertSchedule(OWNER, job.id, { cron: "0 1 * * *", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: null });
    expect(job.ownerId).toBe(OWNER);
    expect(await jobs.get(OTHER, job.id)).toBeNull();
    expect(await jobs.list(OTHER)).toEqual([]);
    expect(await jobs.listSchedules(OTHER)).toEqual([]);
    expect(await jobs.update(OTHER, job.id, { name: "x" })).toBeNull();
    expect(await jobs.upsertSchedule(OTHER, job.id, { cron: "0 2 * * *", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: null })).toBeNull();
    expect(await jobs.deleteSchedule(OTHER, job.id)).toBe(false);
    expect(await jobs.delete(OTHER, job.id)).toBe(false);
    expect((await jobs.system.get(job.id))!.ownerId).toBe(OWNER);
    expect((await jobs.system.listSchedules()).some((s) => s.jobId === job.id)).toBe(true);
    await jobs.system.disableSchedules(OWNER);
    expect((await jobs.get(OWNER, job.id))!.schedule!.enabled).toBe(false);
    expect(await jobs.delete(OWNER, job.id)).toBe(true);
  });

  test("run store and manager on PostgreSQL: lifecycle, events, pagination, recovery, retention", async () => {
    const runs = pgRunStore(sql!);
    const jobs = pgJobStore(sql!);
    const executor = new FakeExecutor();
    const manager = createRunManager({ store: runs, jobs, instances: pgInstanceStore(sql!), executor });
    const job = await jobs.create(OWNER, { name: "J", steps: [step("copy", A, B), step("copy", B, C)] });

    const queued = await manager.start({ job: { id: job.id }, trigger: "manual", ownerId: OWNER, startedBy: "admin", dryRun: false });
    expect(queued.steps.map((s) => s.status)).toEqual(["pending", "pending"]);
    await manager.whenIdle();
    const done = (await runs.getRun(queued.id))!;
    expect(done.status).toBe("completed");
    expect(done.steps.map((s) => s.status)).toEqual(["completed", "completed"]);
    expect(done.steps[0]!.summary).toEqual({ found: 2, transferred: 2 });
    expect(done.settings.steps[0]).toMatchObject({ source: { alias: "a" }, target: { alias: "b" }, options: { kind: "photos" } });
    expect(done.startedAt && done.finishedAt).toBeTruthy();

    const events = await runs.listEvents(queued.id, 0, 1000);
    expect(events.length).toBeGreaterThan(5);
    expect(events.some((e) => e.type === "progress" && (e.data as any).total === 2)).toBe(true);
    expect(typeof events[0]!.id).toBe("number");
    const after = await runs.listEvents(queued.id, events[2]!.id, 1000);
    expect(after.map((e) => e.id)).toEqual(events.slice(3).map((e) => e.id));
    expect((await runs.listEvents(queued.id, 0, 2)).length).toBe(2);

    // pagination and filters
    for (let i = 0; i < 3; i++) await manager.start({ job: { id: job.id }, trigger: "schedule", ownerId: OWNER, startedBy: "schedule", dryRun: true });
    await manager.whenIdle();
    const p1 = await runs.listRuns({ limit: 3, offset: 0 });
    const p2 = await runs.listRuns({ limit: 3, offset: 3 });
    expect(p1.total).toBe(4);
    expect(p1.runs.length).toBe(3);
    expect(p2.runs.length).toBe(1);
    expect(p1.runs[0]!.steps.length).toBe(2);
    expect((await runs.listRuns({ limit: 10, offset: 0, jobId: job.id })).total).toBe(4);
    expect((await runs.listRuns({ limit: 10, offset: 0, status: "failed" })).total).toBe(0);

    // recovery
    const stuck = await runs.createRun({ jobId: job.id, jobName: "stuck", trigger: "manual", startedBy: "admin", dryRun: false, settings: done.settings });
    await runs.markRunning(stuck.id, new Date());
    await runs.updateStep(stuck.id, 1, { status: "running", startedAt: new Date() });
    expect(await manager.recoverInterrupted()).toEqual([stuck.id]);
    const rec = (await runs.getRun(stuck.id))!;
    expect(rec.status).toBe("interrupted");
    expect(rec.steps.map((s) => s.status)).toEqual(["error", "not_run"]);
    expect((await runs.listEvents(stuck.id, 0, 10))[0]!.message).toContain("interrupted");

    // retention
    expect(await runs.getRetentionDays()).toBe(90);
    await runs.setRetentionDays(30);
    expect(await runs.getRetentionDays()).toBe(30);
    await sql!`update runs set created_at = now() - interval '45 days' where id = ${queued.id}`;
    expect(await pruneHistory(runs)).toBe(1);
    expect(await runs.getRun(queued.id)).toBeNull();
    expect((await sql!`select count(*)::int as n from run_events where run_id = ${queued.id}`)[0].n).toBe(0);
    expect((await sql!`select count(*)::int as n from run_steps where run_id = ${queued.id}`)[0].n).toBe(0);

    // deleting the job keeps history (job_id set null)
    await jobs.delete(OWNER, job.id);
    expect((await runs.getRun(stuck.id))!.jobId).toBeNull();
  });
});

describe.skipIf(!url)("skipped runs and stats (PostgreSQL)", () => {
  test("skipped run is stored, filterable, counted out of stats, untouched by recovery, and prunable", async () => {
    const runs = pgRunStore(sql!);
    const settings = { jobId: null, name: "Nightly", dryRun: false, steps: [] };
    const sk = await runs.createSkippedRun({ jobId: null, jobName: "Nightly", settings, reason: "skipped: previous run still active" }, new Date());
    expect(sk).toMatchObject({ status: "skipped", trigger: "schedule", startedBy: "schedule" });
    expect(sk.finishedAt).not.toBeNull();
    expect((await runs.listEvents(sk.id, 0, 10)).map((e) => [e.level, e.message])).toEqual([["warning", "skipped: previous run still active"]]);
    expect((await runs.listRuns({ limit: 5, offset: 0, status: "skipped" })).runs.map((r) => r.id)).toContain(sk.id);
    const done = await runs.createRun({ jobId: null, jobName: "x", trigger: "manual", startedBy: "admin", dryRun: false, settings });
    await runs.finishRun(done.id, "failed", {}, new Date());
    const stats = await runs.statsSince(new Date(Date.now() - 86_400_000));
    expect(stats.failed).toBeGreaterThanOrEqual(1);
    const before = stats.runs;
    await runs.createSkippedRun({ jobId: null, jobName: "Nightly", settings, reason: "skipped" }, new Date());
    expect((await runs.statsSince(new Date(Date.now() - 86_400_000))).runs).toBe(before);
    expect(await runs.recoverInterrupted(new Date())).not.toContain(sk.id);
    expect((await runs.getRun(sk.id))!.status).toBe("skipped");
    await sql!`update runs set created_at = now() - interval '200 days' where id = ${sk.id}`;
    expect(await runs.pruneBefore(new Date(Date.now() - 100 * 86_400_000))).toBeGreaterThanOrEqual(1);
    expect(await runs.getRun(sk.id)).toBeNull();
  });
});
