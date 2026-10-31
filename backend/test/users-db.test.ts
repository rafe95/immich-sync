/** Users, sessions and first-run setup against PostgreSQL; runs only when TEST_DATABASE_URL is set. Uses a throwaway schema. */
import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { hashToken, pgSessionStore } from "../src/auth/sessions.ts";
import { LastAdminError, pgUserStore, UsernameTakenError } from "../src/auth/users.ts";
import { migrate } from "../src/db/migrate.ts";
import { pgUserDataEraser } from "../src/auth/user-deletion.ts";
import { pgInstanceStore } from "../src/instances/store.ts";
import { pgJobStore } from "../src/jobs/store.ts";
import { pgRunStore } from "../src/runs/store.ts";
import { FakeExecutor } from "./fake-executor.ts";
import { loggedIn, seedUser, startTestServer } from "./helpers.ts";

const url = process.env.TEST_DATABASE_URL;
const schema = `test_users_${Date.now()}`;
const sql = url ? new SQL(`${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`) : null;
async function fails(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}
const LONG = "a perfectly fine passphrase";

afterAll(async () => {
  if (!sql) return;
  await sql.unsafe(`drop schema if exists ${schema} cascade`);
  await sql.close();
});

describe.skipIf(!url)("users (PostgreSQL)", () => {
  test("migration: obsolete admin hash and old sessions are removed", async () => {
    await sql!.unsafe(`create schema ${schema}`);
    // apply everything before 0004 by hand to seed the old model
    const dir = `${import.meta.dir}/../src/db/migrations`;
    await sql!`create table schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    for (const f of ["0001_init.sql", "0002_sessions.sql", "0003_skipped_runs.sql"]) {
      await sql!.begin(async (tx) => {
        await tx.unsafe(await Bun.file(`${dir}/${f}`).text());
        await tx`insert into schema_migrations (name) values (${f})`;
      });
    }
    await sql!`insert into settings (key, value) values ('admin_password_hash', '"x"'::jsonb), ('keep', '1'::jsonb)`;
    await sql!`insert into sessions (id_hash, csrf_token, expires_at) values ('old', 'c', now() + interval '1 day')`;
    expect(await migrate(sql!)).toEqual(["0004_users.sql", "0005_ownership.sql"]);
    expect((await sql!`select key from settings`).map((r: any) => r.key)).toEqual(["keep"]);
    expect(await sql!`select 1 from sessions`).toHaveLength(0);
    await sql!`delete from settings`;
  });

  test("markDeleting: sets deleting_at, null for unknown ids, last admin refused", async () => {
    await sql!`delete from users`;
    try {
      const users = pgUserStore(sql!);
      const a = await users.create("solo", "h", "admin");
      await expect(users.markDeleting(a.id, new Date())).rejects.toBeInstanceOf(LastAdminError);
      expect((await users.get(a.id))?.deletingAt).toBeNull();
      expect(await users.markDeleting(crypto.randomUUID(), new Date())).toBeNull();
      const b = await users.create("plain", "h", "user");
      const at = new Date("2026-10-31T10:00:00Z");
      expect((await users.markDeleting(b.id, at))?.deletingAt).toBe(at.toISOString());
      expect((await users.getCredentials("plain"))?.user.deletingAt).toBe(at.toISOString());
      expect((await users.list()).find((u) => u.id === b.id)?.deletingAt).toBe(at.toISOString());
    } finally {
      await sql!`delete from users`;
    }
  });

  test("store: case-insensitive unique usernames, username check, last-admin rules", async () => {
    const users = pgUserStore(sql!);
    expect(await users.count()).toBe(0);
    const a = await users.create("Alice", "h1", "admin");
    expect(a.username).toBe("alice");
    await expect(users.create("ALICE", "h", "user")).rejects.toBeInstanceOf(UsernameTakenError);
    expect(await fails(async () => { await sql!`insert into users (username, role, password_hash) values ('Alice', 'user', 'h')`; })).toBe(true);
    expect(await fails(async () => { await sql!`insert into users (username, role, password_hash) values ('bad name', 'user', 'h')`; })).toBe(true);
    expect(await fails(async () => { await sql!`insert into users (username, role, password_hash) values ('okname', 'root', 'h')`; })).toBe(true);

    expect(await users.createFirstAdmin("zed", "h")).toBeNull(); // a user exists
    await expect(users.update(a.id, { role: "user" })).rejects.toBeInstanceOf(LastAdminError);
    await expect(users.delete(a.id)).rejects.toBeInstanceOf(LastAdminError);
    expect((await users.get(a.id))?.role).toBe("admin");

    const b = await users.create("bob", "h2", "user");
    expect(await users.delete(b.id)).toBe(true);
    expect(await users.delete(b.id)).toBe(false);
    expect(await users.update(b.id, { role: "admin" })).toBeNull();
    await sql!`delete from users`;
  });

  test("two admins cannot demote/delete each other concurrently into zero admins", async () => {
    const users = pgUserStore(sql!);
    const a = await users.create("admin-a", "h", "admin");
    const b = await users.create("admin-b", "h", "admin");
    for (const mode of ["demote", "delete"] as const) {
      const op = (id: string) => (mode === "demote" ? users.update(id, { role: "user" }) : users.delete(id));
      const results = await Promise.allSettled([op(a.id), op(b.id)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")[0]).toMatchObject({ reason: expect.any(LastAdminError) });
      const [{ n }] = await sql!`select count(*)::int as n from users where role = 'admin'`;
      expect(n).toBe(1);
      if (mode === "demote") await sql!`update users set role = 'admin'`;
    }
    await sql!`delete from users`;
  });

  test("deleting admins cannot remove the last usable admin; deletion can be retried", async () => {
    const users = pgUserStore(sql!);
    try {
      const a = await users.create("active-admin", "h", "admin");
      const b = await users.create("deleting-admin", "h", "admin");
      await users.markDeleting(b.id, new Date());
      await expect(users.markDeleting(a.id, new Date())).rejects.toBeInstanceOf(LastAdminError);
      await expect(users.delete(a.id)).rejects.toBeInstanceOf(LastAdminError);
      await expect(users.update(a.id, { role: "user" })).rejects.toBeInstanceOf(LastAdminError);
      expect((await users.get(a.id))?.deletingAt).toBeNull();
      expect((await users.markDeleting(b.id, new Date()))?.deletingAt).not.toBeNull();
      expect(await users.delete(b.id)).toBe(true);
    } finally {
      await sql!`delete from users`;
    }
  });

  test("concurrent deletion lockouts leave one usable admin", async () => {
    const users = pgUserStore(sql!);
    try {
      const a = await users.create("concurrent-a", "h", "admin");
      const b = await users.create("concurrent-b", "h", "admin");
      const results = await Promise.allSettled([users.markDeleting(a.id, new Date()), users.markDeleting(b.id, new Date())]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.any(LastAdminError) });
      expect((await users.list()).filter((u) => u.role === "admin" && !u.deletingAt)).toHaveLength(1);
    } finally {
      await sql!`delete from users`;
    }
  });

  test("session store: deleteForUser keeps the excepted session and other users' sessions", async () => {
    const users = pgUserStore(sql!);
    const s = pgSessionStore(sql!);
    const u = await users.create("sess-a", "h", "user");
    const v = await users.create("sess-b", "h", "user");
    const exp = new Date(Date.now() + 60_000);
    for (const [k, id] of [["1", u.id], ["2", u.id], ["3", v.id]] as const) await s.create(hashToken(k), { csrfToken: "c", expiresAt: exp, userId: id });
    await s.deleteForUser(u.id, hashToken("1"));
    const now = new Date();
    expect(await s.get(hashToken("1"), now)).not.toBeNull();
    expect(await s.get(hashToken("2"), now)).toBeNull();
    expect(await s.get(hashToken("3"), now)).not.toBeNull();
    await s.deleteForUser(u.id);
    expect(await s.get(hashToken("1"), now)).toBeNull();
    await sql!`delete from users`;
  });

  test("setup race over HTTP: concurrent requests create exactly one admin", async () => {
    const t = startTestServer({ users: pgUserStore(sql!), sessions: pgSessionStore(sql!), seedAdmin: false });
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          fetch(`${t.base}/api/setup`, { method: "POST", body: JSON.stringify({ username: `racer${i}`, password: LONG }) }),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(9);
      const [{ n }] = await sql!`select count(*)::int as n from users`;
      expect(n).toBe(1);
      const [{ s }] = await sql!`select count(*)::int as s from sessions`;
      expect(s).toBe(1);
      expect(await (await fetch(`${t.base}/api/setup/status`)).json()).toEqual({ needsSetup: false });
    } finally {
      await t.stop();
    }
    await sql!`delete from users`;
  });

  test("full flow on PostgreSQL: login, create user, reset password, delete user removes sessions", async () => {
    const t = startTestServer({ users: pgUserStore(sql!), sessions: pgSessionStore(sql!), eraser: pgUserDataEraser(sql!) });
    try {
      await t.ready;
      const admin = await loggedIn(t.base);
      const created = await (await admin.call("POST", "/api/users", { username: "Carol", password: LONG })).json();
      const carol = await loggedIn(t.base, "carol", LONG);
      expect((await carol.call("GET", "/api/users")).status).toBe(403);
      // password reset ends her session
      expect((await admin.call("PATCH", `/api/users/${created.user.id}`, { password: "a different passphrase" })).status).toBe(200);
      expect((await fetch(`${t.base}/api/auth/me`, { headers: { cookie: carol.cookie } })).status).toBe(401);
      const carol2 = await loggedIn(t.base, "carol", "a different passphrase");
      // demote check + delete
      expect((await admin.call("PATCH", `/api/users/${admin.user.id}`, { role: "user" })).status).toBe(409);
      expect((await admin.call("DELETE", `/api/users/${admin.user.id}`)).status).toBe(409);
      expect((await admin.call("DELETE", `/api/users/${created.user.id}`)).status).toBe(200);
      expect((await fetch(`${t.base}/api/auth/me`, { headers: { cookie: carol2.cookie } })).status).toBe(401);
      const [{ n }] = await sql!`select count(*)::int as n from sessions where user_id = ${created.user.id}`;
      expect(n).toBe(0);
      // change password for self
      const res = await admin.call("POST", "/api/auth/password", { currentPassword: "correct horse battery", newPassword: "yet another passphrase" });
      expect(res.status).toBe(200);
      expect((await fetch(`${t.base}/api/auth/me`, { headers: { cookie: admin.cookie } })).status).toBe(401);
    } finally {
      await t.stop();
    }
  });
});

describe.skipIf(!url)("user deletion (PostgreSQL)", () => {
  const BOB = "bobs long passphrase";
  const count = async (q: string, id: string) => (await sql!.unsafe(q, [id]))[0].n as number;
  /** Every row that belongs to the owner, table by table. */
  const rowsOf = async (id: string) => ({
    users: await count(`select count(*)::int as n from users where id = $1`, id),
    sessions: await count(`select count(*)::int as n from sessions where user_id = $1`, id),
    instances: await count(`select count(*)::int as n from instances where owner_id = $1`, id),
    jobs: await count(`select count(*)::int as n from jobs where owner_id = $1`, id),
    jobSteps: await count(`select count(*)::int as n from job_steps where job_id in (select id from jobs where owner_id = $1)`, id),
    schedules: await count(`select count(*)::int as n from schedules where job_id in (select id from jobs where owner_id = $1)`, id),
    runs: await count(`select count(*)::int as n from runs where owner_id = $1`, id),
    runSteps: await count(`select count(*)::int as n from run_steps where run_id in (select id from runs where owner_id = $1)`, id),
    runEvents: await count(`select count(*)::int as n from run_events where run_id in (select id from runs where owner_id = $1)`, id),
  });
  const NONE = { users: 0, sessions: 0, instances: 0, jobs: 0, jobSteps: 0, schedules: 0, runs: 0, runSteps: 0, runEvents: 0 };

  async function setup(opts: { timeoutMs?: number } = {}) {
    await sql!.unsafe(`delete from runs; delete from jobs; delete from instances; delete from users`);
    const executor = new FakeExecutor();
    const users = pgUserStore(sql!);
    const store = pgInstanceStore(sql!);
    const t = startTestServer({
      executor, users, sessions: pgSessionStore(sql!), store, jobStore: pgJobStore(sql!), runStore: pgRunStore(sql!),
      eraser: pgUserDataEraser(sql!), deleteTimeoutMs: opts.timeoutMs,
    });
    await t.ready;
    const bobId = (await seedUser(users, "bob", BOB, "user")).id;
    const admin = await loggedIn(t.base);
    const bob = await loggedIn(t.base, "bob", BOB);
    /** A job with an enabled schedule between two of the owner's instances, and one finished dry run of it. */
    const seed = async (client: typeof admin, ownerId: string, prefix: string) => {
      const mk = async (alias: string) => (await store.create(ownerId, { alias, apiUrl: `http://${alias}/api`, apiKeyEnc: Buffer.from("x"), note: null, isDefault: false })).id;
      const steps = [{ operation: "copy", sourceId: await mk(`${prefix}-src`), targetId: await mk(`${prefix}-dst`) }];
      const job = await (await client.call("POST", "/api/jobs", { name: `${prefix} nightly`, steps })).json();
      expect((await client.call("PUT", `/api/jobs/${job.id}/schedule`, { cron: "0 3 * * *" })).status).toBe(201);
      expect((await client.call("POST", `/api/jobs/${job.id}/run`, { dryRun: true })).status).toBe(202);
      await t.manager.whenIdle();
      return job;
    };
    return { ...t, executor, bobId, admin, bob, seed };
  }

  test("deleting a user erases only their rows; counts preview them", async () => {
    const t = await setup();
    try {
      await t.seed(t.admin, t.adminId, "admin");
      await t.seed(t.bob, t.bobId, "bob");
      const adminBefore = await rowsOf(t.adminId);
      expect(await rowsOf(t.bobId)).toMatchObject({ users: 1, sessions: 1, instances: 2, jobs: 1, jobSteps: 1, schedules: 1, runs: 1, runSteps: 1 });
      expect((await rowsOf(t.bobId)).runEvents).toBeGreaterThan(0);
      expect(await (await t.admin.call("GET", `/api/users/${t.bobId}/data`)).json()).toEqual({ instances: 2, jobs: 1, runs: 1 });

      expect((await t.admin.call("DELETE", `/api/users/${t.bobId}`)).status).toBe(200);
      expect(await rowsOf(t.bobId)).toEqual(NONE);
      expect(await rowsOf(t.adminId)).toEqual(adminBefore);
      expect((await fetch(`${t.base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "bob", password: BOB }) })).status).toBe(401);
    } finally {
      await t.stop();
    }
  });

  test("timeout keeps the data and locks the user out; a retry after the run stops erases it", async () => {
    const t = await setup({ timeoutMs: 50 });
    try {
      const job = await t.seed(t.bob, t.bobId, "bob");
      let release!: () => void;
      t.executor.ignoreAbort = true;
      t.executor.gates.set(1, new Promise<void>((r) => (release = r)));
      expect((await t.bob.call("POST", `/api/jobs/${job.id}/run`, {})).status).toBe(202);
      await t.executor.hasStarted(1);

      const res = await t.admin.call("DELETE", `/api/users/${t.bobId}`);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ message: "Runs are still stopping. Try again." });
      expect(await rowsOf(t.bobId)).toMatchObject({ users: 1, sessions: 0, instances: 2, jobs: 1, schedules: 1, runs: 2 });
      const [{ enabled }] = await sql!`select enabled from schedules where job_id = ${job.id}`;
      expect(enabled).toBe(false);
      const [{ deleting_at }] = await sql!`select deleting_at from users where id = ${t.bobId}`;
      expect(deleting_at).not.toBeNull();

      release();
      await t.manager.whenIdle();
      expect((await t.admin.call("DELETE", `/api/users/${t.bobId}`)).status).toBe(200);
      expect(await rowsOf(t.bobId)).toEqual(NONE);
    } finally {
      await t.stop();
    }
  });
});
