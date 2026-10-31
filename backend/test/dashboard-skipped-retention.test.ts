import { describe, expect, test } from "bun:test";
import { encryptSecret } from "../src/crypto.ts";
import { createCoreExecutor } from "../src/runs/executor.ts";
import { memoryInstanceStore, type InstanceStore } from "../src/instances/store.ts";
import { memoryJobStore } from "../src/jobs/store.ts";
import type { StepInput } from "../src/jobs/validation.ts";
import { createRunManager } from "../src/runs/manager.ts";
import { emitEvent, flushProgress } from "../src/runs/runner.ts";
import { RunEventHub } from "../src/runs/hub.ts";
import { memoryRunStore } from "../src/runs/store.ts";
import { ProgressThrottle } from "../src/runs/throttle.ts";
import { createRetentionPruner } from "../src/settings.ts";
import { FakeExecutor } from "./fake-executor.ts";
import { loggedIn, SECRET, startTestServer } from "./helpers.ts";

const OWNER = "99999999-9999-4999-8999-999999999999";
const step = (operation: StepInput["operation"], a: string, b: string): StepInput => ({
  operation, sourceId: a, targetId: b, onFailure: "continue", onError: "stop", options: { range: null, kind: "all", metadata: false, dryRun: false },
});

async function twoInstances(store: Pick<InstanceStore, "create">, ownerId: string) {
  const mk = async (alias: string) => (await store.create(ownerId, { alias, apiUrl: `http://user:pw@${alias}.example/api`, apiKeyEnc: encryptSecret("SECRET-KEY-" + alias, SECRET), note: null, isDefault: false })).id;
  return [await mk("a"), await mk("b")] as [string, string];
}

describe("dashboard API", () => {
  test("requires authentication", async () => {
    const t = startTestServer();
    expect((await fetch(`${t.base}/api/dashboard`)).status).toBe(401);
    t.stop();
  });

  test("returns the exact shape without secrets", async () => {
    const t = startTestServer({ executor: new FakeExecutor() });
    await t.ready;
    const [a, b] = await twoInstances(t.store, t.adminId);
    await t.store.saveCheck(t.adminId, a, { ok: true, version: "3.3.0", versionStatus: "supported", user: { email: "x@y" }, permissions: ["all"], error: null }, new Date("2026-01-01T00:00:00Z"));
    await t.store.saveCheck(t.adminId, b, { ok: false, version: null, versionStatus: null, error: { stage: "ping", message: "down" } }, new Date("2026-01-02T00:00:00Z"));
    const job = await t.jobStore.create(t.adminId, { name: "Nightly", steps: [step("copy", a, b)] });
    await t.jobStore.upsertSchedule(t.adminId, job.id, { cron: "0 3 * * *", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: null });
    const paused = await t.jobStore.create(t.adminId, { name: "Paused", steps: [step("copy", a, b)] });
    await t.jobStore.upsertSchedule(t.adminId, paused.id, { cron: "0 4 * * *", timezone: "UTC", enabled: false, catchUp: false, moveConfirmedAt: null });
    const mv = await t.jobStore.create(t.adminId, { name: "Mover", steps: [step("move", a, b)] });
    await t.jobStore.upsertSchedule(t.adminId, mv.id, { cron: "0 5 * * *", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: null });
    const r = await t.manager.start({ job: { id: job.id }, trigger: "manual", ownerId: t.adminId, startedBy: "admin", dryRun: false });
    await t.manager.whenIdle();
    await t.manager.recordSkipped(job.id, "skipped: previous run still active");

    const { call } = await loggedIn(t.base);
    const res = await call("GET", "/api/dashboard");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["instances", "nextScheduled", "recentRuns", "running", "stats"]);
    expect(body.instances).toEqual([
      { id: a, alias: "a", isDefault: false, lastCheck: { ok: true, versionStatus: "supported", version: "3.3.0" }, lastCheckedAt: "2026-01-01T00:00:00.000Z" },
      { id: b, alias: "b", isDefault: false, lastCheck: { ok: false, versionStatus: null, version: null, error: "down" }, lastCheckedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    expect(body.recentRuns).toHaveLength(2);
    expect(Object.keys(body.recentRuns[0]).sort()).toEqual(["createdAt", "dryRun", "finishedAt", "id", "jobName", "startedAt", "status", "summary", "trigger"]);
    expect(body.recentRuns.map((x: any) => x.status).sort()).toEqual(["completed", "skipped"]);
    expect(body.recentRuns.some((x: any) => x.id === r.id)).toBe(true);
    expect(body.nextScheduled).toHaveLength(1); // paused and unconfirmed move are not upcoming
    expect(body.nextScheduled[0]).toMatchObject({ jobId: job.id, jobName: "Nightly", cron: "0 3 * * *", timezone: "UTC" });
    expect(new Date(body.nextScheduled[0].nextRun).getTime()).toBeGreaterThan(Date.now());
    expect(body.running).toEqual([]);
    expect(body.stats.runsLast7Days).toBe(1); // skipped rows are not counted
    expect(JSON.stringify(body)).not.toMatch(/SECRET-KEY|user:pw|example\/api/);
    t.stop();
  });

  test("limits and ordering: 10 recent runs, 5 upcoming schedules, running runs", async () => {
    const ex = new FakeExecutor();
    const t = startTestServer({ executor: ex });
    await t.ready;
    const [a, b] = await twoInstances(t.store, t.adminId);
    for (let i = 0; i < 7; i++) {
      const j = await t.jobStore.create(t.adminId, { name: `J${i}`, steps: [step("copy", a, b)] });
      await t.jobStore.upsertSchedule(t.adminId, j.id, { cron: `0 ${23 - i} * * *`, timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: null });
    }
    for (let i = 0; i < 12; i++) await t.runStore.createSkippedRun({ jobId: null, jobName: `s${i}`, settings: { jobId: null, name: "x", dryRun: false, steps: [] }, reason: "skipped: x" }, new Date());
    ex.gates.set(1, new Promise(() => {}));
    const live = await t.manager.start({ job: { name: "live", steps: [step("copy", a, b)] }, trigger: "manual", ownerId: t.adminId, startedBy: "admin", dryRun: false });
    await ex.hasStarted(1);
    const { call } = await loggedIn(t.base);
    const body = await (await call("GET", "/api/dashboard")).json();
    expect(body.recentRuns).toHaveLength(10);
    expect(body.nextScheduled).toHaveLength(5);
    const times = body.nextScheduled.map((n: any) => n.nextRun);
    expect([...times].sort()).toEqual(times);
    expect(body.running.map((r: any) => [r.id, r.jobName])).toEqual([[live.id, "live"]]);
    t.manager.abortAll();
    await t.manager.whenIdle();
    t.stop();
  });
});

describe("skipped schedule runs", () => {
  test("recordSkipped creates a finished 'skipped' schedule run with a log event and takes no lock", async () => {
    const instances = memoryInstanceStore();
    const [a, b] = await twoInstances(instances, OWNER);
    const jobs = memoryJobStore();
    const store = memoryRunStore();
    const manager = createRunManager({ store, jobs, instances, executor: new FakeExecutor() });
    const job = await jobs.create(OWNER, { name: "Nightly", steps: [step("move", a, b)] });
    const run = await manager.recordSkipped(job.id, "skipped: previous run still active");
    expect(run).toMatchObject({ status: "skipped", trigger: "schedule", startedBy: "schedule", jobId: job.id, jobName: "Nightly" });
    expect(run.finishedAt).not.toBeNull();
    expect(run.steps.map((s) => s.status)).toEqual(["not_run"]);
    expect(store.events.filter((e) => e.runId === run.id).map((e) => [e.level, e.message])).toEqual([["warning", "skipped: previous run still active"]]);
    expect(manager.isActive(run.id)).toBe(false);
    expect(manager.activeRunForJob(job.id)).toBeNull();
    expect(manager.locks.snapshot().held).toEqual([]);
    expect((await store.listRuns({ limit: 10, offset: 0, status: "skipped" })).total).toBe(1);
    // startup recovery leaves it alone
    expect(await manager.recoverInterrupted()).toEqual([]);
    expect((await store.getRun(run.id))!.status).toBe("skipped");
    // retention prunes it like any finished run
    store.backdate(run.id, new Date("2020-01-01"));
    expect(await store.pruneBefore(new Date("2021-01-01"))).toBe(1);
  });

  test("history filter accepts status=skipped", async () => {
    const t = startTestServer();
    await t.runStore.createSkippedRun({ jobId: null, jobName: "n", settings: { jobId: null, name: "n", dryRun: false, steps: [] }, reason: "skipped: x" }, new Date());
    const { call } = await loggedIn(t.base);
    const res = await (await call("GET", "/api/runs?status=skipped")).json();
    expect(res.total).toBe(1);
    expect(res.runs[0].status).toBe("skipped");
    t.stop();
  });
});

describe("instance checks during runs are stored", () => {
  test("validateInstances saves a redacted last_check", async () => {
    const instances = memoryInstanceStore();
    const [a, b] = await twoInstances(instances, OWNER);
    const ex = createCoreExecutor({
      instances: instances.system, secretKey: SECRET,
      check: async (i) => ({
        alias: i.alias, ok: i.alias === "a", checkedAt: "2026-03-01T00:00:00.000Z", latencyMs: 1, version: i.alias === "a" ? "3.3.0" : null, versionStatus: i.alias === "a" ? "supported" : null,
        user: null, permissions: [], roles: null, warnings: [`warn ${i.apiKey}`],
        error: i.alias === "a" ? null : { stage: "key", message: `rejected ${i.apiKey} at ${i.apiUrl}` },
      }) as never,
    });
    const opts = { range: null, kind: "all", metadata: false, dryRun: false } as const;
    await ex.validateInstances(
      [{ position: 1, operation: "copy", source: { id: a, alias: "a" }, target: { id: b, alias: "b" }, options: opts, onFailure: "continue", onError: "stop" }],
      { runId: "r", signal: new AbortController().signal, log: async () => {} },
    );
    const ra = await instances.get(OWNER, a);
    const rb = await instances.get(OWNER, b);
    expect(ra!.lastCheckedAt).toBe("2026-03-01T00:00:00.000Z");
    expect((ra!.lastCheck as any).ok).toBe(true);
    expect((rb!.lastCheck as any).ok).toBe(false);
    expect(JSON.stringify([ra!.lastCheck, rb!.lastCheck])).not.toMatch(/SECRET-KEY|user:pw|example\/api/);
  });
});

describe("progress throttling", () => {
  const prog = (step: number, done: number) => ({ level: "info" as const, type: "progress", data: { step, done } });

  test("unit: one per interval per step, held event flushed, other types untouched", () => {
    let t = 0;
    const th = new ProgressThrottle(() => t, 1000);
    expect(th.admit("r", prog(1, 1))).toBe(true);
    t = 400;
    expect(th.admit("r", prog(1, 2))).toBe(false);
    expect(th.admit("r", prog(1, 3))).toBe(false);
    expect(th.admit("r", prog(2, 1))).toBe(true); // other step has its own window
    expect(th.admit("r", { level: "info", type: "log", message: "x" })).toBe(true);
    expect(th.admit("r", { level: "info", type: "asset", data: { step: 1 } })).toBe(true);
    t = 1000;
    expect(th.admit("r", prog(1, 4))).toBe(true); // held ones are superseded
    expect(th.flush("r", 1)).toEqual([]);
    t = 1100;
    th.admit("r", prog(1, 5));
    expect(th.flush("r", 1).map((e) => (e.data as any).done)).toEqual([5]);
    expect(th.flush("r", 1)).toEqual([]);
  });

  test("emitEvent persists about one progress per second and flushProgress writes the final one", async () => {
    let t = 0;
    const deps = { store: memoryRunStore(), hub: new RunEventHub(), throttle: new ProgressThrottle(() => t) };
    const live: number[] = [];
    deps.hub.subscribe("r", (m) => m.kind === "event" && m.event.type === "progress" && live.push((m.event.data as any).done));
    for (let i = 1; i <= 30; i++) {
      t = i * 100; // 3 seconds of events
      await emitEvent(deps, "r", prog(1, i));
      await emitEvent(deps, "r", { level: "info", type: "asset", message: `a${i}`, data: { step: 1 } });
    }
    const persisted = () => deps.store.events.filter((e) => e.type === "progress").map((e) => (e.data as any).done);
    expect(persisted().length).toBeLessThanOrEqual(4);
    expect(persisted()[0]).toBe(1);
    expect(persisted().at(-1)).not.toBe(30);
    expect(deps.store.events.filter((e) => e.type === "asset")).toHaveLength(30);
    await flushProgress(deps, "r", 1);
    expect(persisted().at(-1)).toBe(30);
    expect(live.at(-1)).toBe(30);
  });

  test("a run persists the last progress of each step even when throttled", async () => {
    const instances = memoryInstanceStore();
    const [a, b] = await twoInstances(instances, OWNER);
    const store = memoryRunStore();
    const ex = new FakeExecutor();
    const orig = ex.runStep.bind(ex);
    ex.runStep = async (ctx) => {
      for (let i = 1; i <= 5; i++) await ctx.log({ level: "info", type: "progress", data: { step: ctx.position, done: i } });
      return orig(ctx);
    };
    const manager = createRunManager({ store, jobs: memoryJobStore(), instances, executor: ex, nowMs: () => 0 });
    const r = await manager.start({ job: { name: "j", steps: [step("copy", a, b), step("copy", b, a)] }, trigger: "manual", ownerId: OWNER, startedBy: "admin", dryRun: false });
    await manager.whenIdle();
    const progress = store.events.filter((e) => e.runId === r.id && e.type === "progress");
    // frozen clock: the first event per step is written, the rest are held and the last one is flushed at step end
    for (const pos of [1, 2]) expect(progress.filter((e) => (e.data as any).step === pos).map((e) => (e.data as any).done)).toEqual([1, 5]);
  });
});

describe("retention", () => {
  test("GET/PUT validate, require CSRF and persist", async () => {
    const t = startTestServer();
    const { call, cookie } = await loggedIn(t.base);
    expect(await (await call("GET", "/api/settings/retention")).json()).toEqual({ days: 90 });
    expect(await (await call("PUT", "/api/settings/retention", { days: 30 })).json()).toEqual({ days: 30 });
    expect(await (await call("GET", "/api/settings/retention")).json()).toEqual({ days: 30 });
    for (const bad of [0, 3651, 1.5, "30", null]) expect((await call("PUT", "/api/settings/retention", { days: bad })).status).toBe(400);
    expect((await call("PUT", "/api/settings/retention", {})).status).toBe(400);
    expect((await call("PUT", "/api/settings/retention", { days: 1 })).status).toBe(200);
    expect((await call("PUT", "/api/settings/retention", { days: 3650 })).status).toBe(200);
    // no CSRF header
    expect((await fetch(`${t.base}/api/settings/retention`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ days: 5 }) })).status).toBe(403);
    // not logged in
    expect((await fetch(`${t.base}/api/settings/retention`)).status).toBe(401);
    expect(await t.runStore.getRetentionDays()).toBe(3650);
    t.stop();
  });

  test("pruner prunes at start and daily until stopped", async () => {
    const store = memoryRunStore();
    const old = await store.createRun({ jobId: null, jobName: "old", trigger: "manual", startedBy: "admin", dryRun: false, settings: { jobId: null, name: "old", dryRun: false, steps: [] } });
    await store.finishRun(old.id, "completed", {}, new Date());
    store.backdate(old.id, new Date(Date.now() - 100 * 86_400_000));
    let now = Date.now();
    const pending: Array<{ at: number; fn: () => void; id: number }> = [];
    let seq = 0;
    const pruner = createRetentionPruner({
      runs: store,
      timers: {
        now: () => now,
        setTimeout: (fn, ms) => (pending.push({ at: now + ms, fn, id: ++seq }), seq),
        clearTimeout: (h) => void pending.splice(0, pending.length, ...pending.filter((p) => p.id !== h)),
      },
      log: () => {},
    });
    await pruner.start();
    expect(store.runs.size).toBe(0); // pruned at startup (default 90 days)
    expect(pending).toHaveLength(1);
    expect(pending[0]!.at - now).toBe(86_400_000);
    const fresh = await store.createRun({ jobId: null, jobName: "n", trigger: "manual", startedBy: "admin", dryRun: false, settings: { jobId: null, name: "n", dryRun: false, steps: [] } });
    await store.finishRun(fresh.id, "completed", {}, new Date());
    store.backdate(fresh.id, new Date(now - 80 * 86_400_000));
    now += 86_400_000 * 11; // the day passes: it is now 91 days old
    pending.shift()!.fn();
    await new Promise((r) => setTimeout(r, 5));
    expect(store.runs.size).toBe(0);
    expect(pending).toHaveLength(1); // re-armed
    pruner.stop();
    expect(pending).toHaveLength(0);
  });
});
