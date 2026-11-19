import { afterEach, describe, expect, test } from "bun:test";
import { LoginRateLimiter } from "../src/auth/rate-limit.ts";
import { loggedIn, PASSWORD, seedUser, startTestServer, USERNAME } from "./helpers.ts";

const NEW_PASSWORD = "a brand new password";
const ACCEPTED = { message: "If that is an administrator account, a reset token was written to the backend log." };
const INVALID = { message: "The reset token is invalid or has expired." };

let stops: Array<() => unknown> = [];
afterEach(() => {
  stops.forEach((s) => s());
  stops = [];
});

async function start(overrides: Parameters<typeof startTestServer>[0] = {}) {
  const lines: string[] = [];
  const t = startTestServer({ recoveryLog: (l) => lines.push(l), ...overrides });
  stops.push(t.stop);
  await t.ready;
  const post = (path: string, body: unknown) => fetch(`${t.base}${path}`, { method: "POST", body: JSON.stringify(body) });
  const request = (username: string) => post("/api/auth/recovery", { username });
  const complete = (token: string, newPassword = NEW_PASSWORD) => post("/api/auth/recovery/complete", { token, newPassword });
  const login = (password: string, username = USERNAME) => post("/api/auth/login", { username, password });
  return { ...t, lines, request, complete, login };
}

function tokenFrom(lines: string[]): string {
  for (const l of lines) {
    const m = /: (\S+) \(valid until /.exec(l);
    if (m) return m[1]!;
  }
  throw new Error(`no token in log: ${JSON.stringify(lines)}`);
}

describe("admin password recovery", () => {
  test("admin reset end to end", async () => {
    const t = await start();
    const before = await loggedIn(t.base);
    const req = await t.request(USERNAME);
    expect(req.status).toBe(202);
    expect(await req.json()).toEqual(ACCEPTED);
    expect(req.headers.get("set-cookie")).toBeNull();
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).toMatch(new RegExp(`^\\[recovery\\] Password reset token for administrator "${USERNAME}": \\S+ \\(valid until \\d{4}-\\d\\d-\\d\\dT[^)]+Z\\)$`));
    const token = tokenFrom(t.lines);

    const done = await t.complete(token);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ authenticated: true, user: { username: USERNAME, role: "admin" } });
    expect(done.headers.get("set-cookie")).toContain("immich_sync_session=");

    expect((await t.login(PASSWORD)).status).toBe(401);
    expect((await t.login(NEW_PASSWORD)).status).toBe(200);
    expect((await fetch(`${t.base}/api/auth/me`, { headers: { cookie: before.cookie } })).status).toBe(401);
    expect(t.lines.at(-1)).toBe(`[recovery] Password for "${USERNAME}" was reset.`);
    expect(t.lines.some((l) => l.includes(NEW_PASSWORD))).toBe(false);
  });

  test("no session or CSRF token is needed", async () => {
    const t = await start();
    expect((await t.request(USERNAME)).status).toBe(202);
    expect((await t.complete(tokenFrom(t.lines))).status).toBe(200);
  });

  test("non-admin and unknown users get the same response and no token", async () => {
    const t = await start();
    await seedUser(t.users, "bob", PASSWORD, "user");
    const bob = await t.request("bob");
    const nobody = await t.request("nobody");
    expect([bob.status, nobody.status]).toEqual([202, 202]);
    expect(await bob.json()).toEqual(ACCEPTED);
    expect(await nobody.json()).toEqual(ACCEPTED);
    expect(t.lines).toEqual([
      '[recovery] Reset requested for "bob": not an administrator, no token issued.',
      '[recovery] Reset requested for "nobody": not an administrator, no token issued.',
    ]);
  });

  test("a second request does not replace an active token", async () => {
    const t = await start();
    await t.request(USERNAME);
    const token = tokenFrom(t.lines);
    await t.request(USERNAME);
    expect(t.lines).toHaveLength(2);
    expect(t.lines[1]).toMatch(new RegExp(`^\\[recovery\\] A reset token for "${USERNAME}" is already active until \\S+Z; use that one\\.$`));
    expect((await t.complete(token)).status).toBe(200);
  });

  test("a token works only once", async () => {
    const t = await start();
    await t.request(USERNAME);
    const token = tokenFrom(t.lines);
    expect((await t.complete(token)).status).toBe(200);
    const again = await t.complete(token, "yet another new password");
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual(INVALID);
  });

  test("concurrent completes with one token: exactly one succeeds", async () => {
    const t = await start();
    await t.request(USERNAME);
    const token = tokenFrom(t.lines);
    const statuses = (await Promise.all([t.complete(token), t.complete(token)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
  });

  test("usernames are normalized and pasted tokens are trimmed", async () => {
    const t = await start();
    await t.request(`  ${USERNAME.toUpperCase()} `);
    const token = tokenFrom(t.lines);
    expect((await t.complete(`${token}\n`)).status).toBe(200);
  });

  test("a username cannot forge a log line", async () => {
    const t = await start();
    await t.request('x\n[recovery] Password reset token for administrator "admin": fake (valid until z)');
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).not.toContain("\n");
    expect(t.lines[0]).toStartWith('[recovery] Reset requested for an invalid username "x[recovery]');
  });

  test("a username that is not a valid username is logged as invalid, not as another account", async () => {
    const t = await start();
    const res = await t.request(`${USERNAME.slice(0, 1)}\u0000${USERNAME.slice(1)}`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(ACCEPTED);
    expect(t.lines).toEqual([`[recovery] Reset requested for an invalid username "${USERNAME}": no token issued.`]);
  });

  test("wrong tokens back off like failed logins", async () => {
    const t = await start({ limiter: new LoginRateLimiter({ freeAttempts: 2 }) });
    expect((await t.complete("wrong-1")).status).toBe(400);
    expect((await t.complete("wrong-2")).status).toBe(400);
    expect((await t.complete("wrong-3")).status).toBe(429);
  });

  test("requests are throttled and throttled requests are not logged", async () => {
    const t = await start({ recoveryLimiter: new LoginRateLimiter({ freeAttempts: 2 }) });
    expect((await t.request("nobody")).status).toBe(202);
    expect((await t.request("nobody")).status).toBe(202);
    expect((await t.request(USERNAME)).status).toBe(429);
    expect(t.lines).toHaveLength(2);
  });

  test("a weak new password is refused and the token stays usable", async () => {
    const t = await start();
    await t.request(USERNAME);
    const token = tokenFrom(t.lines);
    const weak = await t.complete(token, "short");
    expect(weak.status).toBe(400);
    expect(await weak.json()).toEqual({ message: "The password must be at least 12 characters." });
    expect((await t.complete(token)).status).toBe(200);
  });

  test("a token is refused once its admin is demoted or being deleted", async () => {
    const t = await start();
    await seedUser(t.users, "second", PASSWORD, "admin");
    await t.request(USERNAME);
    await t.users.update(t.adminId, { role: "user" });
    expect((await t.complete(tokenFrom(t.lines))).status).toBe(400);

    const lines2: string[] = [];
    const t2 = await start({ recoveryLog: (l) => lines2.push(l) });
    await seedUser(t2.users, "second", PASSWORD, "admin");
    await t2.request(USERNAME);
    await t2.users.markDeleting(t2.adminId, new Date());
    expect((await t2.complete(tokenFrom(lines2))).status).toBe(400);
  });

  test("an admin being deleted gets no token", async () => {
    const t = await start();
    await seedUser(t.users, "second", PASSWORD, "admin");
    await t.users.markDeleting(t.adminId, new Date());
    await t.request(USERNAME);
    expect(t.lines).toEqual([`[recovery] Reset requested for "${USERNAME}": not an administrator, no token issued.`]);
  });

  test("a normal password change clears a pending token", async () => {
    const t = await start();
    await t.request(USERNAME);
    const token = tokenFrom(t.lines);
    const me = await loggedIn(t.base);
    const changed = await me.call("POST", "/api/auth/password", { currentPassword: PASSWORD, newPassword: "changed the normal way" });
    expect(changed.status).toBe(200);
    expect((await t.complete(token)).status).toBe(400);
  });
});
