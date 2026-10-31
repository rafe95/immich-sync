import { afterEach, describe, expect, test } from "bun:test";
import { LoginRateLimiter } from "../src/auth/rate-limit.ts";
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
    expect(Object.keys(list.users[0]).sort()).toEqual(["createdAt", "id", "lastLoginAt", "role", "username"]);
    expect(list.users.find((u: any) => u.username === "bob").lastLoginAt).toBeTruthy();

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
