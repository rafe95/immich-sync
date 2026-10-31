import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createAuth } from "../src/auth/auth.ts";
import { createUserRoutes } from "../src/auth/user-routes.ts";
import { hashToken, memorySessionStore, pgSessionStore } from "../src/auth/sessions.ts";
import { createUserDeletion, memoryUserDataEraser, pgUserDataEraser } from "../src/auth/user-deletion.ts";
import { memoryUserStore, pgUserStore } from "../src/auth/users.ts";
import { migrate } from "../src/db/migrate.ts";
import { createInstanceRoutes } from "../src/instances/routes.ts";
import { memoryInstanceStore, pgInstanceStore } from "../src/instances/store.ts";
import { createJobRoutes } from "../src/jobs/routes.ts";
import { memoryJobStore, pgJobStore } from "../src/jobs/store.ts";
import type { StepInput } from "../src/jobs/validation.ts";
import { createRunManager } from "../src/runs/manager.ts";
import { memoryRunStore, pgRunStore } from "../src/runs/store.ts";
import { createSettingsRoutes } from "../src/settings.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const url = process.env.TEST_DATABASE_URL;
const schema = `test_owner_races_${Date.now()}`;
const sql = url ? new SQL(`${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`) : null;
let migrated = false;
afterAll(async () => {
  if (!sql) return;
  await sql.unsafe(`drop schema if exists ${schema} cascade`);
  await sql.close();
});

async function setup(pg: boolean) {
  if (pg && !migrated) {
    await sql!.unsafe(`create schema ${schema}`);
    await migrate(sql!);
    migrated = true;
  }
  const memory = { users: memoryUserStore(), instances: memoryInstanceStore(), jobs: memoryJobStore(), runs: memoryRunStore() };
  const users = pg ? pgUserStore(sql!) : memory.users;
  const sessions = pg ? pgSessionStore(sql!) : memorySessionStore();
  const instances = pg ? pgInstanceStore(sql!) : memory.instances;
  const jobs = pg ? pgJobStore(sql!) : memory.jobs;
  const runs = pg ? pgRunStore(sql!) : memory.runs;
  const admin = await users.create(`admin-${crypto.randomUUID()}`, "h", "admin");
  const owner = await users.create(`owner-${crypto.randomUUID()}`, "h", "user");
  const source = await instances.create(owner.id, { alias: "source", apiUrl: "http://source:2283/api", apiKeyEnc: Buffer.from("enc"), note: null, isDefault: false });
  const target = await instances.create(owner.id, { alias: "target", apiUrl: "http://target:2283/api", apiKeyEnc: Buffer.from("enc"), note: null, isDefault: false });
  const step: StepInput = { operation: "copy", sourceId: source.id, targetId: target.id, onFailure: "continue", onError: "stop", options: { range: null, kind: "all", metadata: false, dryRun: false } };
  const job = await jobs.create(owner.id, { name: "job", steps: [step] });
  const schedule = { cron: "0 9 * * *", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: null };
  await jobs.upsertSchedule(owner.id, job.id, schedule);
  const token = crypto.randomUUID();
  await sessions.create(hashToken(token), { userId: owner.id, csrfToken: "csrf", expiresAt: new Date(Date.now() + 60_000) });
  const auth = createAuth({ users, sessions });
  const manager = createRunManager({ store: runs, jobs, instances, owners: { isDeleting: async (id) => {
    const user = await users.get(id);
    return !user || user.deletingAt !== null;
  } }, executor: { run: async () => { throw new Error("must not execute"); } } as never });
  const eraser = pg ? pgUserDataEraser(sql!) : memoryUserDataEraser(memory);
  const deletion = createUserDeletion({ users, sessions, jobs, manager, eraser, timeoutMs: 30 });
  const userRoutes = createUserRoutes({ users, sessions, deletion, eraser });
  const settingsRoutes = createSettingsRoutes({ runs });
  const jobRoutes = createJobRoutes({ jobs, instances, runs: manager, defaultTimezone: "UTC" });
  const instanceRoutes = createInstanceRoutes({ store: instances, secretKey: "s".repeat(40) });
  function stalled(body: unknown, method = "POST", id?: string) {
    const entered = deferred();
    const release = deferred();
    const req = Object.assign(new Request("http://localhost/api/test", { method, headers: { cookie: `immich_sync_session=${token}`, "x-csrf-token": "csrf" } }), {
      params: { id },
      text: async () => { entered.resolve(); await release.promise; return JSON.stringify(body); },
    });
    return { req, entered: entered.promise, release: release.resolve };
  }
  return { users, instances, jobs, runs, admin, owner, job, step, schedule, manager, deletion, auth, stalled, jobRoutes, instanceRoutes, userRoutes, settingsRoutes };
}

for (const pg of [false, true]) describe.skipIf(pg && !url)(`owner deletion races (${pg ? "PostgreSQL" : "memory"})`, () => {
  for (const kind of ["create", "password", "role", "retention"] as const) test(`authenticated admin ${kind} body released after actor deletion cannot mutate surviving data`, async () => {
    const t = await setup(pg);
    await t.users.update(t.owner.id, { role: "admin" });
    await t.users.create(`spare-${crypto.randomUUID()}`, "h", "admin");
    const username = `late-${crypto.randomUUID()}`;
    const survivorToken = crypto.randomUUID();
    await t.auth.sessions.create(hashToken(survivorToken), { userId: t.admin.id, csrfToken: "survivor", expiresAt: new Date(Date.now() + 60_000) });
    const days = await t.runs.getRetentionDays();
    const hash = await t.users.getHash(t.admin.id);
    const payload = kind === "create" ? { username, password: "new-admin-password", role: "admin" }
      : kind === "password" ? { password: "reset-survivor-password" }
      : kind === "role" ? { role: "user" } : { days: days === 42 ? 43 : 42 };
    const body = t.stalled(payload, kind === "create" ? "POST" : "PUT", t.admin.id);
    const handler = kind === "create" ? t.userRoutes.create : kind === "retention" ? t.settingsRoutes.putRetention : t.userRoutes.update;
    const response = t.auth.protectAdmin(handler)(body.req);
    await body.entered;
    try {
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("deleted");
      body.release();
      expect((await response).status).toBe(409);
      expect(await t.users.getCredentials(username)).toBeNull();
      expect(await t.users.getHash(t.admin.id)).toBe(hash);
      expect((await t.users.get(t.admin.id))?.role).toBe("admin");
      expect(await t.auth.sessions.get(hashToken(survivorToken), new Date())).not.toBeNull();
      expect(await t.runs.getRetentionDays()).toBe(days);
    } finally { body.release(); await response.catch(() => {}); }
  });

  for (const kind of ["create", "password", "retention"] as const) test(`admitted admin ${kind} holds actor erasure through the complete mutation`, async () => {
    const t = await setup(pg);
    await t.users.update(t.owner.id, { role: "admin" });
    const entered = deferred();
    const release = deferred();
    if (kind === "create") {
      const create = t.users.create.bind(t.users);
      t.users.create = async (...args) => { entered.resolve(); await release.promise; return create(...args); };
    } else if (kind === "password") {
      // Session invalidation is part of the reset, not work allowed to outlive actor admission.
      const deleteForUser = t.auth.sessions.deleteForUser.bind(t.auth.sessions);
      t.auth.sessions.deleteForUser = async (...args) => {
        if (args[0] === t.admin.id) { entered.resolve(); await release.promise; }
        return deleteForUser(...args);
      };
    } else {
      const setRetentionDays = t.runs.setRetentionDays.bind(t.runs);
      t.runs.setRetentionDays = async (...args) => { entered.resolve(); await release.promise; return setRetentionDays(...args); };
    }
    const body = t.stalled(kind === "create" ? { username: `new-${crypto.randomUUID()}`, password: "new-user-password" }
      : kind === "password" ? { password: "reset-survivor-password" } : { days: 42 }, kind === "create" ? "POST" : "PUT", t.admin.id);
    body.release();
    const handler = kind === "create" ? t.userRoutes.create : kind === "retention" ? t.settingsRoutes.putRetention : t.userRoutes.update;
    const response = t.auth.protectAdmin(handler)(body.req);
    await entered.promise;
    try {
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("stopping");
      expect((await t.users.get(t.owner.id))?.deletingAt).toBeTruthy();
      expect(await t.jobs.get(t.owner.id, t.job.id)).not.toBeNull();
      release.resolve();
      expect((await response).status).toBe(kind === "create" ? 201 : 200);
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("deleted");
    } finally { release.resolve(); await response.catch(() => {}); }
  });

  test("a stale authenticated admin cannot remove a surviving account", async () => {
    const t = await setup(pg);
    await t.users.update(t.owner.id, { role: "admin" });
    await t.users.create(`spare-${crypto.randomUUID()}`, "h", "admin");
    const entered = deferred();
    const release = deferred();
    const get = t.users.get.bind(t.users);
    let hold = true;
    t.users.get = async (id) => {
      const user = await get(id);
      if (id === t.owner.id && hold) {
        hold = false;
        entered.resolve();
        await release.promise;
      }
      return user;
    };
    const body = t.stalled({}, "DELETE", t.admin.id);
    const response = t.auth.protectAdmin(t.userRoutes.remove)(body.req);
    await entered.promise;
    try {
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("deleted");
      release.resolve();
      expect((await response).status).toBe(409);
      expect((await get(t.admin.id))?.deletingAt).toBeNull();
    } finally { release.resolve(); await response.catch(() => {}); }
  });

  test("reciprocal admin removals do not wait on each other's actor barriers", async () => {
    const t = await setup(pg);
    await t.users.update(t.owner.id, { role: "admin" });
    await t.users.create(`spare-${crypto.randomUUID()}`, "h", "admin");
    const token = crypto.randomUUID();
    await t.auth.sessions.create(hashToken(token), { userId: t.admin.id, csrfToken: "csrf", expiresAt: new Date(Date.now() + 60_000) });
    const firstReady = deferred();
    const secondReady = deferred();
    const startFirst = deferred();
    const startSecond = deferred();
    const entered = deferred();
    const release = deferred();
    const markDeleting = t.users.markDeleting.bind(t.users);
    t.users.markDeleting = async (...args) => {
      if (args[0] === t.admin.id) { entered.resolve(); await release.promise; }
      return markDeleting(...args);
    };
    const first = t.auth.protectAdmin(async (req, ctx) => {
      firstReady.resolve(); await startFirst.promise; return t.userRoutes.remove(req, ctx);
    })(t.stalled({}, "DELETE", t.admin.id).req);
    const secondReq = Object.assign(new Request("http://localhost/api/users", { method: "DELETE", headers: { cookie: `immich_sync_session=${token}`, "x-csrf-token": "csrf" } }), { params: { id: t.owner.id } });
    const second = t.auth.protectAdmin(async (req, ctx) => {
      secondReady.resolve(); await startSecond.promise; return t.userRoutes.remove(req, ctx);
    })(secondReq);
    await Promise.all([firstReady.promise, secondReady.promise]);
    try {
      startFirst.resolve();
      await entered.promise;
      startSecond.resolve();
      release.resolve();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(409);
      expect((await t.users.get(t.owner.id))?.deletingAt).toBeNull();
      expect(await t.users.get(t.admin.id)).toBeNull();
    } finally { startFirst.resolve(); startSecond.resolve(); release.resolve(); await Promise.allSettled([first, second]); }
  });

  test("authenticated schedule body released after deletion timeout cannot re-enable schedules", async () => {
    const t = await setup(pg);
    const body = t.stalled({ cron: t.schedule.cron, timezone: t.schedule.timezone, enabled: true }, "PUT", t.job.id);
    const response = t.auth.protect(t.jobRoutes.putSchedule)(body.req);
    await body.entered;
    // Model an outstanding run/start that forces the bounded deletion timeout.
    const held = deferred();
    const deletion = createUserDeletion({ users: t.users, sessions: t.auth.sessions, jobs: t.jobs, eraser: { counts: async () => ({ instances: 0, jobs: 0, runs: 0 }), erase: async () => { throw new Error("must retain data"); } }, manager: { cancelOwner: () => [], pendingStarts: () => [held.promise], waitFor: async () => true }, timeoutMs: 30 });
    try {
      expect(await deletion.remove(t.admin.id, t.owner.id)).toBe("stopping");
      body.release();
      expect((await response).status).toBe(409);
      expect((await t.jobs.get(t.owner.id, t.job.id))?.schedule?.enabled).toBe(false);
      expect((await t.users.get(t.owner.id))?.deletingAt).toBeTruthy();
    } finally { body.release(); held.resolve(); await response.catch(() => {}); }
  });

  for (const kind of ["instance", "job"] as const) test(`authenticated ${kind} body released after erase is refused without an orphan or FK error`, async () => {
    const t = await setup(pg);
    const body = t.stalled(kind === "instance" ? { alias: "late", apiUrl: "http://late:2283/api", apiKey: "key" } : { name: "late", steps: [t.step] });
    const response = t.auth.protect(kind === "instance" ? t.instanceRoutes.create : t.jobRoutes.create)(body.req);
    await body.entered;
    try {
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("deleted");
      body.release();
      expect((await response).status).toBe(409);
      expect(await t.instances.list(t.owner.id)).toEqual([]);
      expect(await t.jobs.list(t.owner.id)).toEqual([]);
    } finally { body.release(); await response.catch(() => {}); }
  });

  for (const kind of ["instance", "job"] as const) test(`already admitted ${kind} insert holds erasure, times out with data retained, and permits retry`, async () => {
    const t = await setup(pg);
    const entered = deferred();
    const release = deferred();
    if (kind === "instance") {
      const create = t.instances.create.bind(t.instances);
      t.instances.create = async (...args) => { entered.resolve(); await release.promise; return create(...args); };
    } else {
      const create = t.jobs.create.bind(t.jobs);
      t.jobs.create = async (...args) => { entered.resolve(); await release.promise; return create(...args); };
    }
    const body = t.stalled(kind === "instance" ? { alias: "late", apiUrl: "http://late:2283/api", apiKey: "key" } : { name: "late", steps: [t.step] });
    body.release();
    const response = t.auth.protect(kind === "instance" ? t.instanceRoutes.create : t.jobRoutes.create)(body.req);
    await entered.promise;
    try {
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("stopping");
      expect(await t.users.get(t.owner.id)).not.toBeNull();
      expect(await t.jobs.get(t.owner.id, t.job.id)).not.toBeNull();
      release.resolve();
      expect((await response).status).toBe(201);
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("deleted");
      expect(await t.instances.list(t.owner.id)).toEqual([]);
    } finally { release.resolve(); await response.catch(() => {}); }
  });

  test("skipped insert already in flight prevents erase until settled, including timeout and retry", async () => {
    const t = await setup(pg);
    const entered = deferred();
    const release = deferred();
    const createSkipped = t.runs.createSkippedRun.bind(t.runs);
    t.runs.createSkippedRun = async (...args) => { entered.resolve(); await release.promise; return createSkipped(...args); };
    const skipped = t.manager.recordSkipped(t.job.id, "previous run active");
    await entered.promise;
    try {
      expect(t.manager.pendingStarts(t.owner.id)).toHaveLength(1);
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("stopping");
      expect(await t.users.get(t.owner.id)).not.toBeNull();
      release.resolve();
      expect((await skipped).status).toBe("skipped");
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("deleted");
      expect((await t.runs.listRuns(t.owner.id, { limit: 10, offset: 0 })).total).toBe(0);
    } finally { release.resolve(); await skipped.catch(() => {}); }
  });

  test("an admitted schedule write finishing after timeout is paused before its boundary is released", async () => {
    const t = await setup(pg);
    const entered = deferred();
    const release = deferred();
    const upsert = t.jobs.upsertSchedule.bind(t.jobs);
    t.jobs.upsertSchedule = async (...args) => { entered.resolve(); await release.promise; return upsert(...args); };
    const body = t.stalled({ cron: t.schedule.cron, timezone: "UTC", enabled: true }, "PUT", t.job.id);
    body.release();
    const response = t.auth.protect(t.jobRoutes.putSchedule)(body.req);
    await entered.promise;
    try {
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("stopping");
      expect((await t.jobs.get(t.owner.id, t.job.id))?.schedule?.enabled).toBe(false);
      release.resolve();
      expect((await response).status).toBe(200);
      expect((await t.jobs.get(t.owner.id, t.job.id))?.schedule?.enabled).toBe(false);
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("deleted");
    } finally { release.resolve(); await response.catch(() => {}); }
  });

  test("a blocked disable operation is bounded and retains owner data", async () => {
    const t = await setup(pg);
    const release = deferred();
    const disable = t.jobs.system.disableSchedules.bind(t.jobs.system);
    t.jobs.system.disableSchedules = async (id) => { await release.promise; await disable(id); };
    try {
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("stopping");
      expect(await t.users.get(t.owner.id)).not.toBeNull();
      expect(await t.jobs.get(t.owner.id, t.job.id)).not.toBeNull();
      release.resolve();
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("deleted");
    } finally { release.resolve(); }
  });

  if (pg) test("a real PostgreSQL schedule row lock cannot extend the deletion wait or allow erasure", async () => {
    const t = await setup(true);
    const locked = deferred();
    const release = deferred();
    const transaction = sql!.begin(async (tx) => {
      await tx`select id from schedules where job_id = ${t.job.id} for update`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const entered = deferred();
    const upsert = t.jobs.upsertSchedule.bind(t.jobs);
    t.jobs.upsertSchedule = async (...args) => { entered.resolve(); return upsert(...args); };
    const body = t.stalled({ cron: t.schedule.cron, timezone: "UTC", enabled: true }, "PUT", t.job.id);
    body.release();
    const response = t.auth.protect(t.jobRoutes.putSchedule)(body.req);
    await entered.promise;
    try {
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("stopping");
      expect(await t.users.get(t.owner.id)).not.toBeNull();
      release.resolve();
      await transaction;
      expect((await response).status).toBe(200);
      expect((await t.jobs.get(t.owner.id, t.job.id))?.schedule?.enabled).toBe(false);
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("deleted");
    } finally { release.resolve(); await transaction; await response.catch(() => {}); }
  });

  test("a stale owner check inside admission is rechecked after deletion closes the boundary", async () => {
    const t = await setup(pg);
    const entered = deferred();
    const release = deferred();
    const get = t.users.get.bind(t.users);
    let reads = 0;
    t.users.get = async (id) => {
      const user = await get(id);
      if (id === t.owner.id && ++reads === 2) { entered.resolve(); await release.promise; }
      return user;
    };
    const body = t.stalled({ alias: "late", apiUrl: "http://late:2283/api", apiKey: "key" });
    body.release();
    const response = t.auth.protect(t.instanceRoutes.create)(body.req);
    await entered.promise;
    try {
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("stopping");
      release.resolve();
      expect((await response).status).toBe(409);
      expect((await t.instances.list(t.owner.id)).map((i) => i.alias).sort()).toEqual(["source", "target"]);
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("deleted");
    } finally { release.resolve(); await response.catch(() => {}); }
  });

  test("a failed schedule disable never permits erasure", async () => {
    const t = await setup(pg);
    t.jobs.system.disableSchedules = async () => { throw new Error("database unavailable"); };
    await expect(t.deletion.remove(t.admin.id, t.owner.id)).rejects.toThrow("database unavailable");
    expect(await t.users.get(t.owner.id)).not.toBeNull();
    expect(await t.jobs.get(t.owner.id, t.job.id)).not.toBeNull();
  });

  test("owner deletion observed while building a skipped snapshot refuses persistence", async () => {
    const t = await setup(pg);
    const entered = deferred();
    const release = deferred();
    const list = t.instances.list.bind(t.instances);
    t.instances.list = async (id) => { const found = await list(id); entered.resolve(); await release.promise; return found; };
    const skipped = t.manager.recordSkipped(t.job.id, "previous run active");
    await entered.promise;
    try {
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("stopping");
      release.resolve();
      await expect(skipped).rejects.toMatchObject({ status: 409 });
      expect((await t.runs.listRuns(t.owner.id, { limit: 10, offset: 0 })).total).toBe(0);
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("deleted");
    } finally { release.resolve(); await skipped.catch(() => {}); }
  });

  test("late skipped firing whose job lookup preceded erase is refused", async () => {
    const t = await setup(pg);
    const entered = deferred();
    const release = deferred();
    const get = t.jobs.system.get.bind(t.jobs.system);
    t.jobs.system.get = async (id) => { const job = await get(id); entered.resolve(); await release.promise; return job; };
    const skipped = t.manager.recordSkipped(t.job.id, "unconfirmed move");
    await entered.promise;
    try {
      expect(await t.deletion.remove(t.admin.id, t.owner.id)).toBe("deleted");
      release.resolve();
      await expect(skipped).rejects.toMatchObject({ status: 409 });
      expect((await t.runs.listRuns(t.owner.id, { limit: 10, offset: 0 })).total).toBe(0);
    } finally { release.resolve(); await skipped.catch(() => {}); }
  });
});