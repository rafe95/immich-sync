import { describe, expect, test } from "bun:test";
import { memoryInstanceStore } from "../src/instances/store.ts";
import { memoryJobStore } from "../src/jobs/store.ts";
import type { StepInput } from "../src/jobs/validation.ts";
import { createRunManager } from "../src/runs/manager.ts";
import { memoryRunStore, pruneHistory } from "../src/runs/store.ts";
import { FakeExecutor } from "./fake-executor.ts";

const OWNER = "99999999-9999-4999-8999-999999999999";

async function setup() {
  const instances = memoryInstanceStore();
  const mk = async (alias: string) => (await instances.create(OWNER, { alias, apiUrl: `http://${alias}/api`, apiKeyEnc: Buffer.from("x"), note: null, isDefault: false })).id;
  const [A, B, C] = [await mk("A"), await mk("B"), await mk("C")] as [string, string, string];
  const store = memoryRunStore();
  const jobs = memoryJobStore();
  const executor = new FakeExecutor();
  const manager = createRunManager({ store, jobs, instances, executor });
  const step = (operation: StepInput["operation"], sourceId: string, targetId: string, over: Partial<StepInput> = {}): StepInput => ({
    operation, sourceId, targetId, onFailure: "continue", onError: "stop", options: { range: null, kind: "all", metadata: true, dryRun: false }, ...over,
  });
  const run = async (steps: StepInput[], dryRun = false) => {
    const r = await manager.start({ job: { name: "job", steps }, trigger: "manual", ownerId: OWNER, startedBy: "admin", dryRun });
    return r;
  };
  const finished = async (id: string) => {
    await manager.whenIdle();
    return (await store.getRun(OWNER, id))!;
  };
  return { A, B, C, store, jobs, executor, manager, step, run, finished, instances };
}
const statuses = (r: { steps: Array<{ status: string }> }) => r.steps.map((s) => s.status);

describe("run orchestration with a fake executor", () => {
  test("validates all instances first, then runs steps in order and completes", async () => {
    const t = await setup();
    const queued = await t.run([t.step("copy", t.A, t.B), t.step("copy", t.B, t.C)]);
    expect(queued.status).toBe("queued");
    expect(queued.settings.steps[0]).toMatchObject({ source: { alias: "A" }, target: { alias: "B" } });
    const r = await t.finished(queued.id);
    expect(t.executor.calls.map((c) => c.kind + (c.position ?? ""))).toEqual(["validate", "step1", "step2"]);
    expect(r.status).toBe("completed");
    expect(statuses(r)).toEqual(["completed", "completed"]);
    expect(r.startedAt).not.toBeNull();
    expect(r.finishedAt).not.toBeNull();
    expect(r.steps[0]!.summary).toEqual({ found: 2, transferred: 2 });
    const types = t.store.events.map((e) => e.type);
    expect(types).toContain("progress");
    expect(types.filter((x) => x === "summary").length).toBe(2);
    // event ids are strictly increasing
    const ids = t.store.events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test("a validation problem stops everything before step 1, marks all steps not_run", async () => {
    const t = await setup();
    t.executor.problems = [{ instanceId: t.C, alias: "C", message: "key rejected" }];
    const r = await t.finished((await t.run([t.step("copy", t.A, t.B), t.step("copy", t.B, t.C)])).id);
    expect(r.status).toBe("failed");
    expect(statuses(r)).toEqual(["not_run", "not_run"]);
    expect(t.executor.calls.some((c) => c.kind === "step")).toBe(false);
    expect(t.store.events.some((e) => e.level === "error" && e.message === "C: key rejected")).toBe(true);
  });

  test("failures continue by default, stop when the step says so", async () => {
    const t = await setup();
    t.executor.outcomes.set(1, { status: "completed_with_failures", summary: { failed: 1 } });
    let r = await t.finished((await t.run([t.step("copy", t.A, t.B), t.step("copy", t.B, t.C)])).id);
    expect(r.status).toBe("completed_with_failures");
    expect(statuses(r)).toEqual(["completed_with_failures", "completed"]);

    r = await t.finished((await t.run([t.step("copy", t.A, t.B, { onFailure: "stop" }), t.step("copy", t.B, t.C)])).id);
    expect(r.status).toBe("completed_with_failures");
    expect(statuses(r)).toEqual(["completed_with_failures", "not_run"]);
  });

  test("an error stops the job by default and marks later steps not_run; 'continue' runs on", async () => {
    const t = await setup();
    t.executor.outcomes.set(1, { status: "error", message: "server down" });
    let r = await t.finished((await t.run([t.step("copy", t.A, t.B), t.step("copy", t.B, t.C), t.step("copy", t.A, t.C)])).id);
    expect(r.status).toBe("failed");
    expect(statuses(r)).toEqual(["error", "not_run", "not_run"]);

    r = await t.finished((await t.run([t.step("copy", t.A, t.B, { onError: "continue" }), t.step("copy", t.B, t.C)])).id);
    expect(r.status).toBe("completed_with_failures");
    expect(statuses(r)).toEqual(["error", "completed"]);
  });

  test("an executor that throws is recorded as a step error", async () => {
    const t = await setup();
    t.executor.outcomes.set(1, new Error("boom"));
    const r = await t.finished((await t.run([t.step("copy", t.A, t.B), t.step("copy", t.B, t.C)])).id);
    expect(r.status).toBe("failed");
    expect(statuses(r)).toEqual(["error", "not_run"]);
    expect(r.steps[0]!.summary).toEqual({ message: "boom" });
  });

  test("cancel during a step: the step ends cancelled, later steps not_run, run cancelled", async () => {
    const t = await setup();
    t.executor.gates.set(1, new Promise(() => {}));
    const queued = await t.run([t.step("copy", t.A, t.B), t.step("copy", t.B, t.C)]);
    await t.executor.hasStarted(1);
    expect(t.manager.cancel(queued.id)).toBe(true);
    const r = await t.finished(queued.id);
    expect(r.status).toBe("cancelled");
    expect(statuses(r)).toEqual(["cancelled", "not_run"]);
    expect(t.manager.cancel(queued.id)).toBe(false);
  });

  test("cancel while a step completes normally still stops before the next step", async () => {
    const t = await setup();
    let release!: () => void;
    t.executor.gates.set(1, new Promise((r) => (release = r)));
    t.executor.outcomes.set(1, { status: "completed" }); // the executor reports success even though cancel was requested
    const queued = await t.run([t.step("copy", t.A, t.B), t.step("copy", t.B, t.C)]);
    await t.executor.hasStarted(1);
    release();
    t.manager.cancel(queued.id);
    const r = await t.finished(queued.id);
    expect(r.status).toBe("cancelled");
    expect(statuses(r)).toEqual(["completed", "not_run"]);
  });

  test("a run waiting for a lock reports 'queued: waiting for B' and starts when released; unrelated runs are parallel", async () => {
    const t = await setup();
    t.executor.gates.set(1, new Promise((r) => setTimeout(r, 80)));
    const first = await t.run([t.step("copy", t.A, t.B)]);
    await t.executor.hasStarted(1);
    // second run writes the same target B; third writes C only
    t.executor.gates.delete(1);
    const second = await t.run([t.step("copy", t.C, t.B)]);
    const third = await t.run([t.step("copy", t.A, t.C)]);
    await Bun.sleep(10);
    expect((await t.store.getRun(OWNER, second.id))!.status).toBe("queued");
    expect(t.store.events.some((e) => e.runId === second.id && e.message === "queued: waiting for B")).toBe(true);
    expect((await t.store.getRun(OWNER, third.id))!.status).not.toBe("queued");
    await t.manager.whenIdle();
    for (const id of [first.id, second.id, third.id]) expect((await t.store.getRun(OWNER, id))!.status).toBe("completed");
    expect(t.manager.locks.snapshot()).toEqual({ held: [], waiting: [] });
  });

  test("cancelling a queued run never starts it and releases nothing it does not hold", async () => {
    const t = await setup();
    t.executor.gates.set(1, new Promise(() => {}));
    const first = await t.run([t.step("copy", t.A, t.B)]);
    await t.executor.hasStarted(1);
    const second = await t.run([t.step("copy", t.C, t.B)]);
    await Bun.sleep(5);
    t.manager.cancel(second.id);
    await Bun.sleep(5);
    const r2 = (await t.store.getRun(OWNER, second.id))!;
    expect(r2.status).toBe("cancelled");
    expect(statuses(r2)).toEqual(["not_run"]);
    expect(r2.startedAt).toBeNull();
    t.manager.cancel(first.id);
    await t.manager.whenIdle();
  });

  test("dry runs take no locks, flag every step, and note the batch caveat", async () => {
    const t = await setup();
    t.executor.gates.set(1, new Promise(() => {}));
    const real = await t.run([t.step("move", t.A, t.B)]);
    await t.executor.hasStarted(1);
    t.executor.gates.delete(1);
    const dry = await t.run([t.step("move", t.A, t.B), t.step("copy", t.B, t.C)], true);
    await Bun.sleep(20);
    expect((await t.store.getRun(OWNER, dry.id))!.status).toBe("completed");
    expect(dry.dryRun).toBe(true);
    expect(dry.settings.steps.every((s) => s.options.dryRun)).toBe(true);
    expect(t.executor.calls.filter((c) => c.kind === "step" && c.position === 2).every((c) => c.dryRun)).toBe(true);
    expect(t.store.events.some((e) => e.runId === dry.id && /later step/.test(e.message ?? ""))).toBe(true);
    t.manager.cancel(real.id);
    await t.manager.whenIdle();
  });

  test("starting a run for an unknown job or deleted instance is rejected", async () => {
    const t = await setup();
    await expect(t.manager.start({ job: { id: crypto.randomUUID() }, trigger: "manual", ownerId: OWNER, startedBy: "admin", dryRun: false })).rejects.toMatchObject({ status: 404 });
    await expect(t.run([t.step("copy", t.A, crypto.randomUUID())])).rejects.toMatchObject({ status: 400 });
  });

  test("settings snapshot is independent of later job edits", async () => {
    const t = await setup();
    const job = await t.jobs.create(OWNER, { name: "J", steps: [t.step("copy", t.A, t.B)] });
    const run = await t.manager.start({ job: { id: job.id }, trigger: "schedule", ownerId: OWNER, startedBy: "schedule", dryRun: false });
    await t.jobs.update(OWNER, job.id, { steps: [t.step("move", t.B, t.C)] });
    await t.manager.whenIdle();
    const stored = (await t.store.getRun(OWNER, run.id))!;
    expect(stored.settings.steps[0]).toMatchObject({ operation: "copy", source: { alias: "A" } });
    expect(stored).toMatchObject({ trigger: "schedule", startedBy: "schedule", jobId: job.id, jobName: "J" });
  });
});

describe("history", () => {
  test("startup recovery marks queued/running runs interrupted, others untouched", async () => {
    const t = await setup();
    const done = await t.finished((await t.run([t.step("copy", t.A, t.B)])).id);
    const settings = done.settings;
    const stuck = await t.store.createRun({ ownerId: OWNER, jobId: null, jobName: "stuck", trigger: "manual", startedBy: "admin", dryRun: false, settings });
    await t.store.markRunning(stuck.id, new Date());
    await t.store.updateStep(stuck.id, 1, { status: "running" });
    const ids = await t.manager.recoverInterrupted();
    expect(ids).toEqual([stuck.id]);
    const r = (await t.store.getRun(OWNER, stuck.id))!;
    expect(r.status).toBe("interrupted");
    expect(statuses(r)).toEqual(["error"]);
    expect((await t.store.getRun(OWNER, done.id))!.status).toBe("completed");
  });

  test("pagination and filters, newest first", async () => {
    const t = await setup();
    for (let i = 0; i < 5; i++) await t.finished((await t.run([t.step("copy", t.A, t.B)])).id);
    t.executor.outcomes.set(1, { status: "error" });
    await t.finished((await t.run([t.step("copy", t.A, t.B)])).id);
    const page1 = await t.store.listRuns(OWNER, { limit: 4, offset: 0 });
    const page2 = await t.store.listRuns(OWNER, { limit: 4, offset: 4 });
    expect(page1.total).toBe(6);
    expect(page1.runs.length).toBe(4);
    expect(page2.runs.length).toBe(2);
    expect(new Set([...page1.runs, ...page2.runs].map((r) => r.id)).size).toBe(6);
    expect((await t.store.listRuns(OWNER, { limit: 10, offset: 0, status: "failed" })).total).toBe(1);
  });

  test("retention: default 90 days, configurable, prunes finished old runs only", async () => {
    const t = await setup();
    expect(await t.store.getRetentionDays()).toBe(90);
    const old = await t.finished((await t.run([t.step("copy", t.A, t.B)])).id);
    const fresh = await t.finished((await t.run([t.step("copy", t.A, t.B)])).id);
    t.store.backdate(old.id, new Date(Date.now() - 100 * 86_400_000));
    expect(await pruneHistory(t.store)).toBe(1);
    expect(await t.store.getRun(OWNER, old.id)).toBeNull();
    expect(t.store.events.some((e) => e.runId === old.id)).toBe(false);
    expect(await t.store.getRun(OWNER, fresh.id)).not.toBeNull();
    await t.store.setRetentionDays(7);
    t.store.backdate(fresh.id, new Date(Date.now() - 8 * 86_400_000));
    expect(await pruneHistory(t.store)).toBe(1);
    await t.store.setRetentionDays(-5);
    expect(await t.store.getRetentionDays()).toBe(90);
  });
});
