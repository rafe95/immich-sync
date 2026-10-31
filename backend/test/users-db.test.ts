/** Users, sessions and first-run setup against PostgreSQL; runs only when TEST_DATABASE_URL is set. Uses a throwaway schema. */
import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { hashToken, pgSessionStore } from "../src/auth/sessions.ts";
import { LastAdminError, pgUserStore, UsernameTakenError } from "../src/auth/users.ts";
import { migrate } from "../src/db/migrate.ts";
import { loggedIn, startTestServer } from "./helpers.ts";

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
    const t = startTestServer({ users: pgUserStore(sql!), sessions: pgSessionStore(sql!) });
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
