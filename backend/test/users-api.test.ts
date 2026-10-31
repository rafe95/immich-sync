import { afterEach, describe, expect, test } from "bun:test";
import { LoginRateLimiter } from "../src/auth/rate-limit.ts";
import { memorySessionStore } from "../src/auth/sessions.ts";
import { createUserDeletion, memoryUserDataEraser, type UserDataEraser } from "../src/auth/user-deletion.ts";
import { LastAdminError, memoryUserStore } from "../src/auth/users.ts";
import { memoryInstanceStore } from "../src/instances/store.ts";
import { memoryJobStore } from "../src/jobs/store.ts";
import { createRunManager } from "../src/runs/manager.ts";
import { memoryRunStore } from "../src/runs/store.ts";
import { FakeExecutor } from "./fake-executor.ts";
import { loggedIn, PASSWORD, seedUser, startTestServer, USERNAME } from "./helpers.ts";

let stops: Array<() => unknown> = [];
afterEach(() => {
  stops.forEach((s) => s());
  stops = [];
});
function start(...args: Parameters<typeof startTestServer>) {
  const t = startTestServer(...args);
  stops.push(t.stop);
  return t;
}
const LONG = "a perfectly fine passphrase";
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body), headers });

describe("first-run setup", () => {
  test("status, happy path, then closed", async () => {
    const { base, users } = start({ seedAdmin: false });
    expect(await (await fetch(`${base}/api/setup/status`)).json()).toEqual({ needsSetup: true });

    const res = await post(base, "/api/setup", { username: "Alice", password: LONG });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ authenticated: true, user: { username: "alice", role: "admin" } });
    expect(typeof body.csrfToken).toBe("string");
    expect(body.user.id).toBeTruthy();
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(JSON.stringify(body)).not.toContain(LONG);
    const stored = (await users.getHash(body.user.id))!;
    expect(stored).toStartWith("$argon2id$");

    // the new session works
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: cookie.split(";")[0]! } });
    expect(me.status).toBe(200);
    expect(await (await fetch(`${base}/api/setup/status`)).json()).toEqual({ needsSetup: false });

    // closed for good: nothing is created, the first user is untouched
    const again = await post(base, "/api/setup", { username: "mallory", password: "another long passphrase" });
    expect(again.status).toBe(409);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect((await users.list()).map((u) => u.username)).toEqual(["alice"]);
  });

  test("validates username and password", async () => {
    const { base, users } = start({ seedAdmin: false });
    for (const bad of [
      { username: "ab", password: LONG },
      { username: "has space", password: LONG },
      { username: "x".repeat(65), password: LONG },
      { username: "alice", password: "short" },
      { username: "alice", password: "p".repeat(257) },
      { username: "alice" },
      {},
    ]) {
      expect((await post(base, "/api/setup", bad)).status).toBe(400);
    }
    expect((await fetch(`${base}/api/setup`, { method: "POST", body: "[]" })).status).toBe(400);
    expect(await users.count()).toBe(0);
  });

  test("concurrent requests: exactly one succeeds", async () => {
    const { base, users } = start({ seedAdmin: false });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => post(base, "/api/setup", { username: `racer${i}`, password: LONG })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    expect(await users.count()).toBe(1);
  });

  test("a closed setup never counts toward the login backoff and never hashes", async () => {
    const { base } = start({ limiter: new LoginRateLimiter({ freeAttempts: 2, baseDelayMs: 60_000 }) });
    for (let i = 0; i < 6; i++) expect((await post(base, "/api/setup", { username: "mallory", password: LONG })).status).toBe(409);
    // Six refused setups from the same address must not block the real admin from logging in.
    const login = await post(base, "/api/auth/login", { username: USERNAME, password: PASSWORD });
    expect(login.status).toBe(200);
  });

  test("needs no CSRF token (there is no session yet)", async () => {
    const { base } = start({ seedAdmin: false });
    expect((await post(base, "/api/setup", { username: "alice", password: LONG })).status).toBe(201);
  });
});

describe("users API", () => {
  async function twoUsers() {
    const t = start();
    await seedUser(t.users, "bob", LONG, "user");
    const admin = await loggedIn(t.base);
    const bob = await loggedIn(t.base, "bob", LONG);
    return { ...t, admin, bob };
  }

  test("non-admins get 403 on users and retention, but keep the rest", async () => {
    const { bob } = await twoUsers();
    expect((await bob.call("GET", "/api/users")).status).toBe(403);
    expect((await bob.call("POST", "/api/users", { username: "eve", password: LONG })).status).toBe(403);
    expect((await bob.call("PATCH", `/api/users/${bob.user.id}`, { role: "admin" })).status).toBe(403);
    expect((await bob.call("DELETE", `/api/users/${crypto.randomUUID()}`)).status).toBe(403);
    expect((await bob.call("GET", "/api/settings/retention")).status).toBe(403);
    expect((await bob.call("PUT", "/api/settings/retention", { days: 5 })).status).toBe(403);
    expect((await bob.call("GET", "/api/instances")).status).toBe(200);
    expect((await bob.call("GET", "/api/dashboard")).status).toBe(200);
  });

  test("anonymous requests are 401; CSRF is still required", async () => {
    const { base, admin } = await twoUsers();
    expect((await fetch(`${base}/api/users`)).status).toBe(401);
    expect((await fetch(`${base}/api/users`, { method: "POST", body: "{}" })).status).toBe(401);
    const noCsrf = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, { method, headers: { cookie: admin.cookie }, body: body ? JSON.stringify(body) : undefined });
    expect((await noCsrf("POST", "/api/users", { username: "eve", password: LONG })).status).toBe(403);
    expect((await noCsrf("PATCH", `/api/users/${admin.user.id}`, { role: "user" })).status).toBe(403);
    expect((await noCsrf("DELETE", `/api/users/${crypto.randomUUID()}`)).status).toBe(403);
    expect((await fetch(`${base}/api/users`, { headers: { cookie: admin.cookie } })).status).toBe(200);
  });

  test("list, create (default role user), duplicates and invalid input", async () => {
    const { admin } = await twoUsers();
    const list = (await (await admin.call("GET", "/api/users")).json()) as any;
    expect(list.users.map((u: any) => [u.username, u.role])).toEqual([["admin", "admin"], ["bob", "user"]]);
    expect(Object.keys(list.users[0]).sort()).toEqual(["createdAt", "deletingAt", "id", "lastLoginAt", "role", "username"]);
    expect(list.users.find((u: any) => u.username === "bob").lastLoginAt).toBeTruthy();
    expect(list.users[0].deletingAt).toBeNull();

    const created = await admin.call("POST", "/api/users", { username: "Carol", password: LONG });
    expect(created.status).toBe(201);
    expect((await created.json()).user).toMatchObject({ username: "carol", role: "user", lastLoginAt: null });
    expect((await admin.call("POST", "/api/users", { username: "dave", password: LONG, role: "admin" })).status).toBe(201);

    expect((await admin.call("POST", "/api/users", { username: "CAROL", password: LONG })).status).toBe(409);
    expect((await admin.call("POST", "/api/users", { username: "Admin", password: LONG })).status).toBe(409);
    for (const bad of [
      { username: "no", password: LONG },
      { username: "bad name!", password: LONG },
      { username: "erin", password: "short" },
      { username: "erin", password: LONG, role: "root" },
    ]) {
      expect((await admin.call("POST", "/api/users", bad)).status).toBe(400);
    }
    // never echoes secrets
    expect(JSON.stringify(list)).not.toContain("hash");
    expect(JSON.stringify(list)).not.toContain(LONG);
  });

  test("a created user can log in", async () => {
    const { base, admin } = await twoUsers();
    await admin.call("POST", "/api/users", { username: "carol", password: LONG });
    const c = await loggedIn(base, "carol", LONG);
    expect(c.user.role).toBe("user");
  });

  test("last admin: cannot be demoted or deleted; with a second admin it can", async () => {
    const { admin, bob } = await twoUsers();
    const demote = await admin.call("PATCH", `/api/users/${admin.user.id}`, { role: "user" });
    expect(demote.status).toBe(409);
    expect((await demote.json()).message).toContain("last administrator");

    // promote bob, then the original admin may be demoted
    expect((await admin.call("PATCH", `/api/users/${bob.user.id}`, { role: "admin" })).status).toBe(200);
    expect((await admin.call("PATCH", `/api/users/${admin.user.id}`, { role: "user" })).status).toBe(200);
    // bob is now the only admin: the demoted user (no longer admin) is locked out, bob cannot be demoted
    expect((await admin.call("GET", "/api/users")).status).toBe(403);
    expect((await bob.call("PATCH", `/api/users/${bob.user.id}`, { role: "user" })).status).toBe(409);
  });

  test("deleting the last admin is refused even by another request path", async () => {
    const t = start();
    const admin = await loggedIn(t.base);
    const bob = await seedUser(t.users, "bob", LONG, "admin");
    // admin deletes bob (fine), then bob's gone and admin is last
    expect((await admin.call("DELETE", `/api/users/${bob.id}`)).status).toBe(200);
    await expect(t.users.delete(admin.user.id)).rejects.toThrow("last administrator");
  });

  test("an admin cannot delete themselves", async () => {
    const { admin, base } = await twoUsers();
    const res = await admin.call("DELETE", `/api/users/${admin.user.id}`);
    expect(res.status).toBe(409);
    expect((await res.json()).message).toContain("own account");
    expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: admin.cookie } })).status).toBe(200);
  });

  test("delete removes the user and ends their sessions; unknown ids are 404", async () => {
    const { admin, bob, base } = await twoUsers();
    expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: bob.cookie } })).status).toBe(200);
    expect((await admin.call("DELETE", `/api/users/${bob.user.id}`)).status).toBe(200);
    expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: bob.cookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "bob", password: LONG }) })).status).toBe(401);
    expect((await admin.call("DELETE", `/api/users/${bob.user.id}`)).status).toBe(404);
    expect((await admin.call("DELETE", "/api/users/not-a-uuid")).status).toBe(404);
  });

  test("existing session is rejected after markDeleting", async () => {
    const { bob, base, users } = await twoUsers();
    expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: bob.cookie } })).status).toBe(200);
    await users.markDeleting(bob.user.id, new Date());
    const res = await fetch(`${base}/api/auth/me`, { headers: { cookie: bob.cookie } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Authentication required." });
  });

  test("admin password reset signs the user out and changes the credential", async () => {
    const { admin, bob, base } = await twoUsers();
    const NEW = "brand new reset passphrase";
    expect((await admin.call("PATCH", `/api/users/${bob.user.id}`, { password: "short" })).status).toBe(400);
    expect((await admin.call("PATCH", `/api/users/${bob.user.id}`, {})).status).toBe(400);
    expect((await admin.call("PATCH", `/api/users/${crypto.randomUUID()}`, { password: NEW })).status).toBe(404);
    const res = await admin.call("PATCH", `/api/users/${bob.user.id}`, { password: NEW });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain(NEW);
    expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: bob.cookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: admin.cookie } })).status).toBe(200);
    const login = (password: string) => fetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "bob", password }) });
    expect((await login(LONG)).status).toBe(401);
    expect((await login(NEW)).status).toBe(200);
  });
});

describe("login", () => {
  test("login is refused once deletion started, exactly like a wrong password", async () => {
    const { base, users } = start({ limiter: new LoginRateLimiter({ freeAttempts: 1, baseDelayMs: 60_000 }) });
    const bob = await seedUser(users, "bob", LONG, "user");
    await users.markDeleting(bob.id, new Date());
    const res = await post(base, "/api/auth/login", { username: "bob", password: LONG });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Invalid username or password." });
    expect(res.headers.get("set-cookie")).toBeNull();
    // counted toward the backoff (one free attempt, already used)
    expect((await post(base, "/api/auth/login", { username: USERNAME, password: PASSWORD })).status).toBe(429);
  });

  test("markDeleting: null for unknown ids; a doomed last admin is never locked out", async () => {
    const { users } = start();
    expect(await users.markDeleting(crypto.randomUUID(), new Date())).toBeNull();
    const [admin] = await users.list();
    await expect(users.markDeleting(admin!.id, new Date())).rejects.toBeInstanceOf(LastAdminError);
    const bob = await seedUser(users, "bob", LONG, "user");
    const at = new Date("2026-10-31T10:00:00Z");
    expect((await users.markDeleting(bob.id, at))?.deletingAt).toBe(at.toISOString());
    expect((await users.list()).find((u) => u.id === bob.id)?.deletingAt).toBe(at.toISOString());
  });

  test("no users yet -> 409 needsSetup", async () => {
    const { base } = start({ seedAdmin: false });
    const res = await post(base, "/api/auth/login", { username: "alice", password: LONG });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ needsSetup: true });
  });

  test("unknown users still cost a password verification and share the backoff", async () => {
    const { base } = start({ limiter: new LoginRateLimiter({ freeAttempts: 2, baseDelayMs: 60_000 }) });
    for (const u of ["ghost1", "ghost2"]) expect((await post(base, "/api/auth/login", { username: u, password: PASSWORD })).status).toBe(401);
    expect((await post(base, "/api/auth/login", { username: USERNAME, password: PASSWORD })).status).toBe(429);
  });
});

describe("deleting a user", () => {
  const BOB = "bobs long passphrase";
  async function setup(opts: { timeoutMs?: number; onErase?: (userId: string) => void } = {}) {
    const executor = new FakeExecutor();
    const users = memoryUserStore();
    const store = memoryInstanceStore();
    const jobStore = memoryJobStore();
    const runStore = memoryRunStore();
    const inner = memoryUserDataEraser({ users, instances: store, jobs: jobStore, runs: runStore });
    const erased: string[] = [];
    const eraser: UserDataEraser = {
      counts: inner.counts,
      erase: async (id) => {
        opts.onErase?.(id);
        erased.push(id);
        await inner.erase(id);
      },
    };
    const t = start({ executor, users, store, jobStore, runStore, eraser, deleteTimeoutMs: opts.timeoutMs });
    await t.ready;
    const bobUser = await seedUser(users, "bob", BOB, "user");
    const admin = await loggedIn(t.base);
    const bob = await loggedIn(t.base, "bob", BOB);
    const mk = async (ownerId: string, alias: string) =>
      (await store.create(ownerId, { alias, apiUrl: `http://${alias}/api`, apiKeyEnc: Buffer.from("x"), note: null, isDefault: false })).id;
    const steps = (s: string, d: string) => [{ operation: "copy", sourceId: s, targetId: d }];
    /** An owner's job (with an enabled schedule) between two of their instances. */
    const jobFor = async (client: Awaited<ReturnType<typeof loggedIn>>, ownerId: string, prefix: string) => {
      const [s, d] = [await mk(ownerId, `${prefix}-src`), await mk(ownerId, `${prefix}-dst`)];
      const job = await (await client.call("POST", "/api/jobs", { name: `${prefix} nightly`, steps: steps(s, d) })).json();
      expect((await client.call("PUT", `/api/jobs/${job.id}/schedule`, { cron: "0 3 * * *" })).status).toBe(201);
      return { job, s, d };
    };
    const login = (username: string, password: string) => post(t.base, "/api/auth/login", { username, password });
    const ownedRuns = (ownerId: string) => [...runStore.runs.values()].filter((r) => r.ownerId === ownerId);
    return { ...t, executor, users, store, jobStore, runStore, bobId: bobUser.id, admin, bob, jobFor, mk, steps, login, ownedRuns, erased };
  }

  test("deleting a user erases only their data", async () => {
    const t = await setup();
    const mine = await t.jobFor(t.admin, t.adminId, "admin");
    const theirs = await t.jobFor(t.bob, t.bobId, "bob");
    expect((await t.admin.call("POST", `/api/jobs/${mine.job.id}/run`, { dryRun: true })).status).toBe(202);
    expect((await t.bob.call("POST", `/api/jobs/${theirs.job.id}/run`, { dryRun: true })).status).toBe(202);
    await t.manager.whenIdle();
    const bobRunIds = t.ownedRuns(t.bobId).map((r) => r.id);
    expect(bobRunIds).toHaveLength(1);

    const res = await t.admin.call("DELETE", `/api/users/${t.bobId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    expect(await t.users.get(t.bobId)).toBeNull();
    expect(await t.store.list(t.bobId)).toEqual([]);
    expect(await t.store.system.get(theirs.s)).toBeNull();
    expect(await t.jobStore.list(t.bobId)).toEqual([]);
    expect(await t.jobStore.system.get(theirs.job.id)).toBeNull();
    expect((await t.jobStore.system.listSchedules()).map((s) => s.jobId)).toEqual([mine.job.id]);
    expect(t.ownedRuns(t.bobId)).toEqual([]);
    expect(t.runStore.events.filter((e) => bobRunIds.includes(e.runId))).toEqual([]);
    // the admin's data is intact
    expect((await t.store.list(t.adminId)).map((i) => i.id).sort()).toEqual([mine.s, mine.d].sort());
    expect((await t.jobStore.get(t.adminId, mine.job.id))?.schedule?.enabled).toBe(true);
    expect(t.ownedRuns(t.adminId)).toHaveLength(1);
    expect(t.runStore.events.some((e) => e.runId === t.ownedRuns(t.adminId)[0]!.id)).toBe(true);
    // bob is gone for good
    expect((await t.login("bob", BOB)).status).toBe(401);
    expect((await fetch(`${t.base}/api/auth/me`, { headers: { cookie: t.bob.cookie } })).status).toBe(401);
    expect((await t.admin.call("DELETE", `/api/users/${t.bobId}`)).status).toBe(404);
  });

  test("deleting a user cancels their active run first", async () => {
    let abortedAtErase: boolean[] = [];
    const t = await setup({ onErase: () => (abortedAtErase = t.executor.signals.map((s) => s.aborted)) });
    const theirs = await t.jobFor(t.bob, t.bobId, "bob");
    t.executor.gates.set(1, new Promise(() => {}));
    const run = await (await t.bob.call("POST", `/api/jobs/${theirs.job.id}/run`, {})).json();
    await t.executor.hasStarted(1);
    expect(t.manager.isActive(run.id)).toBe(true);

    expect((await t.admin.call("DELETE", `/api/users/${t.bobId}`)).status).toBe(200);
    expect(abortedAtErase).toEqual([true]);
    expect(t.manager.isActive(run.id)).toBe(false);
    expect(await t.runStore.system.getRun(run.id)).toBeNull();
    expect(t.runStore.events.filter((e) => e.runId === run.id)).toEqual([]);
  });

  test("queued run behind another user's lock is cancelled; the other run continues", async () => {
    const t = await setup();
    const mine = await t.jobFor(t.admin, t.adminId, "admin");
    const theirs = await t.jobFor(t.bob, t.bobId, "bob");
    let release!: () => void;
    t.executor.gates.set(1, new Promise<void>((r) => (release = r)));
    const adminRun = await (await t.admin.call("POST", `/api/jobs/${mine.job.id}/run`, {})).json();
    await t.executor.hasStarted(1);
    // Instances belong to one owner, so two users' runs never share a lock through the API. Model "bob is queued
    // behind the admin's run" by letting the admin's run also hold bob's target in the shared lock manager.
    const held = await t.manager.locks.acquire(adminRun.id, [theirs.d]);
    const bobRun = await (await t.bob.call("POST", `/api/jobs/${theirs.job.id}/run`, {})).json();
    while (!t.runStore.events.some((e) => e.runId === bobRun.id && e.message?.startsWith("queued: waiting for"))) await Bun.sleep(1);
    expect((await t.runStore.system.getRun(bobRun.id))?.status).toBe("queued");

    expect((await t.admin.call("DELETE", `/api/users/${t.bobId}`)).status).toBe(200);
    expect(t.manager.isActive(bobRun.id)).toBe(false);
    expect(await t.runStore.system.getRun(bobRun.id)).toBeNull();
    expect(t.executor.calls.filter((c) => c.kind === "step")).toHaveLength(1); // bob's run never reached a step
    // the admin's run is untouched and still running
    expect(t.manager.isActive(adminRun.id)).toBe(true);
    expect(t.executor.signals.map((s) => s.aborted)).toEqual([false]);
    held.release();
    release();
    await t.manager.whenIdle();
    expect((await t.runStore.system.getRun(adminRun.id))?.status).toBe("completed");
  });

  test("timeout returns 409 and keeps data", async () => {
    const t = await setup({ timeoutMs: 50 });
    const theirs = await t.jobFor(t.bob, t.bobId, "bob");
    let release!: () => void;
    t.executor.ignoreAbort = true;
    t.executor.gates.set(1, new Promise<void>((r) => (release = r)));
    const run = await (await t.bob.call("POST", `/api/jobs/${theirs.job.id}/run`, {})).json();
    await t.executor.hasStarted(1);

    const res = await t.admin.call("DELETE", `/api/users/${t.bobId}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ message: "Runs are still stopping. Try again." });
    expect(t.erased).toEqual([]);
    expect(t.executor.signals.map((s) => s.aborted)).toEqual([true]);
    // data kept
    expect((await t.users.get(t.bobId))?.deletingAt).toBeTruthy();
    expect(await t.store.list(t.bobId)).toHaveLength(2);
    expect(await t.jobStore.list(t.bobId)).toHaveLength(1);
    expect(await t.runStore.system.getRun(run.id)).not.toBeNull();
    // locked out, schedules disabled, no new runs
    expect((await t.login("bob", BOB)).status).toBe(401);
    expect((await fetch(`${t.base}/api/auth/me`, { headers: { cookie: t.bob.cookie } })).status).toBe(401);
    expect((await t.jobStore.system.get(theirs.job.id))?.schedule?.enabled).toBe(false);
    await expect(t.manager.start({ job: { id: theirs.job.id }, trigger: "manual", ownerId: t.bobId, startedBy: "bob", dryRun: true })).rejects.toThrow("being deleted");
    const listed = (await (await t.admin.call("GET", "/api/users")).json()).users.find((u: any) => u.id === t.bobId);
    expect(listed.deletingAt).toBeTruthy();

    release();
    await t.manager.whenIdle();
    expect((await t.runStore.system.getRun(run.id))?.status).toBe("cancelled");
    expect((await t.admin.call("DELETE", `/api/users/${t.bobId}`)).status).toBe(200);
    expect(t.erased).toEqual([t.bobId]);
    expect(await t.users.get(t.bobId)).toBeNull();
    expect(await t.store.list(t.bobId)).toEqual([]);
    expect(await t.runStore.system.getRun(run.id)).toBeNull();
  });

  test("data preview counts", async () => {
    const t = await setup();
    const inst = await t.mk(t.bobId, "only");
    // Created through the stores so the counts are exactly one each (a job through the API needs two instances).
    const job = await t.jobStore.create(t.bobId, { name: "x", steps: [] });
    await t.runStore.createRun({ ownerId: t.bobId, jobId: job.id, jobName: "x", trigger: "manual", startedBy: "bob", dryRun: true, settings: { jobId: job.id, name: "x", dryRun: true, steps: [] } });
    expect(inst).toBeTruthy();
    const res = await t.admin.call("GET", `/api/users/${t.bobId}/data`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ instances: 1, jobs: 1, runs: 1 });
    expect(await (await t.admin.call("GET", `/api/users/${t.adminId}/data`)).json()).toEqual({ instances: 0, jobs: 0, runs: 0 });
    expect((await t.admin.call("GET", `/api/users/${crypto.randomUUID()}/data`)).status).toBe(404);
    expect((await t.bob.call("GET", `/api/users/${t.bobId}/data`)).status).toBe(403);
  });
});

describe("user deletion service", () => {
  test("a run launched between cancelling and erasing is caught", async () => {
    const users = memoryUserStore();
    const sessions = memorySessionStore();
    const instances = memoryInstanceStore();
    const jobs = memoryJobStore();
    const runs = memoryRunStore();
    const executor = new FakeExecutor();
    executor.gates.set(1, new Promise(() => {}));
    const bob = await seedUser(users, "bob", "bobs long passphrase", "user");
    await seedUser(users, "root", "roots long passphrase", "admin");
    const mk = async (alias: string) => (await instances.create(bob.id, { alias, apiUrl: `http://${alias}/api`, apiKeyEnc: Buffer.from("x"), note: null, isDefault: false })).id;
    const [s, d] = [await mk("s"), await mk("d")];
    // The start's "is the owner being deleted?" answer is read before deletion begins, then held back.
    let answered!: () => void;
    const held = new Promise<void>((r) => (answered = r));
    let firstCheck = true;
    const owners = {
      isDeleting: async (id: string) => {
        const deleting = (await users.get(id))?.deletingAt != null;
        if (firstCheck) {
          firstCheck = false;
          await held;
        }
        return deleting;
      },
    };
    const manager = createRunManager({ store: runs, jobs, instances, executor, owners });
    const late = manager.start({ job: { name: "late", steps: [{ operation: "copy", sourceId: s, targetId: d, options: { range: { lastDays: 1 }, kind: "photos", metadata: true, dryRun: false }, onFailure: "continue", onError: "stop" }] }, trigger: "manual", ownerId: bob.id, startedBy: "bob", dryRun: false });
    await Bun.sleep(0);
    let atErase: { active: string[]; statuses: string[] } | null = null;
    const inner = memoryUserDataEraser({ users, instances, jobs, runs });
    const deletion = createUserDeletion({
      users, sessions, jobs, eraser: { counts: inner.counts, erase: async (id) => {
        atErase = { active: manager.activeRunIds(), statuses: [...runs.runs.values()].map((r) => r.status) };
        await inner.erase(id);
      } },
      manager: {
        cancelOwner: (id) => {
          const ids = manager.cancelOwner(id);
          answered(); // the held start now proceeds and launches its run after this scan
          return ids;
        },
        pendingStarts: (id) => manager.pendingStarts(id),
        waitFor: (ids, ms) => manager.waitFor(ids, ms),
      },
      timeoutMs: 5_000,
    });
    expect(await deletion.remove("someone-else", bob.id)).toBe("deleted");
    const run = await late;
    // The late run was launched, found by a re-scan, cancelled and finished before anything was erased.
    expect(atErase!).toEqual({ active: [], statuses: ["cancelled"] });
    expect(await runs.system.getRun(run.id)).toBeNull();
    expect(await users.get(bob.id)).toBeNull();
  });
});
