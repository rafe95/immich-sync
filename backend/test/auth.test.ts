import { afterEach, describe, expect, test } from "bun:test";
import { LoginRateLimiter } from "../src/auth/rate-limit.ts";
import { clientKeyFor, createAuth, safeEqual } from "../src/auth/auth.ts";
import { memoryUserStore } from "../src/auth/users.ts";
import { memorySessionStore } from "../src/auth/sessions.ts";
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
const login = (base: string, password: string, headers: Record<string, string> = {}, username = USERNAME) =>
  fetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password }), headers });

describe("auth", () => {
  test("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  test("the environment cannot provide a login: with no users, login says setup is needed", async () => {
    const { base } = start({ seedAdmin: false });
    const res = await login(base, "anything at all");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ needsSetup: true });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("health is public; /api needs a session", async () => {
    const { base } = start();
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    for (const path of ["/api/auth/me", "/api/instances", "/api/whatever"]) {
      expect((await fetch(`${base}${path}`)).status).toBe(401);
    }
    expect((await fetch(`${base}/api/auth/logout`, { method: "POST" })).status).toBe(401);
  });

  test("wrong password is rejected, no cookie issued", async () => {
    const { base } = start();
    const res = await login(base, "nope");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await login(base, "")).status).toBe(401);
    // unknown user and wrong password look the same
    const unknown = await login(base, PASSWORD, {}, "nobody");
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ message: "Invalid username or password." });
    // usernames are case-insensitive
    expect((await login(base, PASSWORD, {}, "ADMIN")).status).toBe(200);
    expect((await fetch(`${base}/api/auth/login`, { method: "POST", body: "[]" })).status).toBe(400);
  });

  test("login sets an HttpOnly SameSite=Strict cookie; me works; logout ends the session", async () => {
    const { base } = start();
    const res = await login(base, PASSWORD);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Secure");
    const { csrfToken } = (await res.json()) as { csrfToken: string };
    const cookie = setCookie.split(";")[0]!;

    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    expect(await me.json()).toEqual({ authenticated: true, csrfToken, user: { id: expect.any(String), username: USERNAME, role: "admin" } });

    // logout is state-changing: needs the CSRF header
    expect((await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie } })).status).toBe(403);
    const out = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie, "x-csrf-token": csrfToken } });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await fetch(`${base}/api/auth/me`, { headers: { cookie } })).status).toBe(401);
  });

  test("Secure flag follows HTTPS (X-Forwarded-Proto) in auto mode and the explicit setting otherwise", async () => {
    const { base } = start();
    const proxied = await login(base, PASSWORD, { "x-forwarded-proto": "https" });
    expect(proxied.headers.get("set-cookie")).toContain("; Secure");
    const forced = start({ secureCookies: true });
    expect((await login(forced.base, PASSWORD)).headers.get("set-cookie")).toContain("; Secure");
  });

  test("CSRF: state-changing requests need the session's token, safe methods do not", async () => {
    const { base } = start();
    const { cookie, csrfToken } = await loggedIn(base);
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/api/instances`, { method: "POST", headers: { cookie, ...headers }, body: "{}" });
    expect((await post({})).status).toBe(403);
    expect((await post({ "x-csrf-token": "wrong" })).status).toBe(403);
    expect((await post({ "x-csrf-token": csrfToken })).status).toBe(400); // passed the guard, failed validation
    expect((await fetch(`${base}/api/instances`, { headers: { cookie } })).status).toBe(200);
    for (const method of ["PATCH", "DELETE"]) {
      const res = await fetch(`${base}/api/instances/${crypto.randomUUID()}`, { method, headers: { cookie } });
      expect(res.status).toBe(403);
    }
    // another session's token does not work
    const other = await loggedIn(base);
    expect((await post({ "x-csrf-token": other.csrfToken })).status).toBe(403);
  });

  test("expired sessions are rejected", async () => {
    let now = Date.now();
    const sessions = memorySessionStore();
    const users = memoryUserStore();
    await seedUser(users, USERNAME, PASSWORD, "admin");
    const auth = createAuth({ users, sessions, now: () => new Date(now) });
    const res = await auth.login(new Request("http://x/api/auth/login", { method: "POST", body: JSON.stringify({ username: USERNAME, password: PASSWORD }) }), "c");
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const me = () => auth.me(new Request("http://x/api/auth/me", { headers: { cookie } }) as never);
    expect((await me()).status).toBe(200);
    now += 25 * 60 * 60 * 1000;
    expect((await me()).status).toBe(401);
  });

  test("repeated failures lock out further attempts, even with the right password", async () => {
    const { base } = start({ limiter: new LoginRateLimiter({ freeAttempts: 3, baseDelayMs: 60_000 }) });
    for (let i = 0; i < 3; i++) expect((await login(base, "bad")).status).toBe(401);
    const blocked = await login(base, PASSWORD);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("LoginRateLimiter", () => {
  test("exponential backoff, cap, reset on success and forgetting", () => {
    let t = 0;
    const l = new LoginRateLimiter({ now: () => t, freeAttempts: 2, baseDelayMs: 1000, maxDelayMs: 4000, forgetAfterMs: 100_000 });
    l.recordFailure("a");
    expect(l.retryAfterSeconds("a")).toBe(0);
    l.recordFailure("a");
    expect(l.retryAfterSeconds("a")).toBe(1);
    t += 1000;
    l.recordFailure("a");
    expect(l.retryAfterSeconds("a")).toBe(2);
    t += 2000;
    l.recordFailure("a");
    l.recordFailure("a");
    l.recordFailure("a");
    expect(l.retryAfterSeconds("a")).toBe(4);
    expect(l.retryAfterSeconds("other")).toBe(0);
    l.recordSuccess("a");
    expect(l.retryAfterSeconds("a")).toBe(0);
    l.recordFailure("b");
    l.recordFailure("b");
    t += 100_001;
    expect(l.retryAfterSeconds("b")).toBe(0);
  });
});

describe("change password", () => {
  const NEW = "a much longer new passphrase";
  const change = (base: string, cookie: string, csrf: string | null, body: unknown) =>
    fetch(`${base}/api/auth/password`, {
      method: "POST",
      headers: { cookie, ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify(body),
    });

  test("requires a session and CSRF", async () => {
    const { base } = start();
    expect((await fetch(`${base}/api/auth/password`, { method: "POST", body: "{}" })).status).toBe(401);
    const { cookie } = await loggedIn(base);
    expect((await change(base, cookie, null, { currentPassword: PASSWORD, newPassword: NEW })).status).toBe(403);
  });

  test("rejects a wrong current password, short, equal and malformed input", async () => {
    const users = memoryUserStore();
    const { base } = start({ users });
    const { cookie, csrfToken, user } = await loggedIn(base);
    const before = await users.getHash(user.id);
    expect((await change(base, cookie, csrfToken, { currentPassword: "wrong", newPassword: NEW })).status).toBe(403);
    expect((await change(base, cookie, csrfToken, { currentPassword: PASSWORD, newPassword: "short" })).status).toBe(400);
    expect((await change(base, cookie, csrfToken, { currentPassword: PASSWORD, newPassword: PASSWORD })).status).toBe(400); // equal (PASSWORD is 21 chars)
    expect((await change(base, cookie, csrfToken, { currentPassword: PASSWORD })).status).toBe(400);
    expect((await fetch(`${base}/api/auth/password`, { method: "POST", headers: { cookie, "x-csrf-token": csrfToken }, body: "[]" })).status).toBe(400);
    expect(await users.getHash(user.id)).toBe(before);
    expect((await login(base, PASSWORD)).status).toBe(200); // unchanged
  });

  test("stores an argon2id hash, switches the credential, ends all sessions and rotates the current one", async () => {
    const users = memoryUserStore();
    const { base } = start({ users });
    const a = await loggedIn(base);
    const b = await loggedIn(base);
    const res = await change(base, a.cookie, a.csrfToken, { currentPassword: PASSWORD, newPassword: NEW });
    expect(res.status).toBe(200);
    const stored = (await users.getHash(a.user.id))!;
    expect(stored).toStartWith("$argon2id$");
    expect(stored).not.toContain(NEW);
    const fresh = (await res.json()) as { csrfToken: string };
    const freshCookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect(fresh.csrfToken).not.toBe(a.csrfToken);
    expect(freshCookie).not.toBe(a.cookie);
    // old sessions are gone, the rotated one works
    expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: a.cookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: b.cookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: freshCookie } })).status).toBe(200);
    // the old password no longer works
    expect((await login(base, PASSWORD)).status).toBe(401);
    expect((await login(base, NEW)).status).toBe(200);
    // and the new one must differ from the (new) current
    expect((await change(base, freshCookie, fresh.csrfToken, { currentPassword: NEW, newPassword: NEW })).status).toBe(400);
  });

  test("a corrupt stored hash fails closed", async () => {
    const users = memoryUserStore();
    await users.create("broken", "not-a-hash", "user");
    const { base } = start({ users });
    expect((await login(base, PASSWORD, {}, "broken")).status).toBe(401);
  });

  test("changing one user's password leaves other users' sessions alone", async () => {
    const users = memoryUserStore();
    const { base } = start({ users });
    await seedUser(users, "bob", "bobs long passphrase", "user");
    const admin = await loggedIn(base);
    const bob = await loggedIn(base, "bob", "bobs long passphrase");
    const bob2 = await loggedIn(base, "bob", "bobs long passphrase");
    const res = await change(base, bob.cookie, bob.csrfToken, { currentPassword: "bobs long passphrase", newPassword: NEW });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).user.username).toBe("bob");
    expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: bob2.cookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: admin.cookie } })).status).toBe(200);
    expect((await login(base, NEW, {}, "bob")).status).toBe(200);
    expect((await login(base, PASSWORD)).status).toBe(200); // admin untouched
  });

  test("wrong current passwords share the login backoff", async () => {
    const { base } = start({ limiter: new LoginRateLimiter({ freeAttempts: 2, baseDelayMs: 60_000 }) });
    const { cookie, csrfToken } = await loggedIn(base);
    for (let i = 0; i < 2; i++) expect((await change(base, cookie, csrfToken, { currentPassword: "bad", newPassword: NEW })).status).toBe(403);
    const blocked = await change(base, cookie, csrfToken, { currentPassword: PASSWORD, newPassword: NEW });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("login backoff client key", () => {
  const req = (xff?: string) => new Request("http://x/", { headers: xff ? { "x-forwarded-for": xff } : {} });

  test("clientKeyFor ignores X-Forwarded-For unless trusted", () => {
    expect(clientKeyFor(req("1.2.3.4, 10.0.0.1"), "172.18.0.2", false)).toBe("172.18.0.2");
    expect(clientKeyFor(req("1.2.3.4, 10.0.0.1"), "172.18.0.2", true)).toBe("1.2.3.4");
    expect(clientKeyFor(req(), "172.18.0.2", true)).toBe("172.18.0.2");
    expect(clientKeyFor(req(), undefined, false)).toBe("unknown");
  });

  const failures = async (base: string, xff: string) => {
    for (let i = 0; i < 2; i++) await login(base, "bad", { "x-forwarded-for": xff });
    return (await login(base, PASSWORD, { "x-forwarded-for": xff })).status;
  };

  test("untrusted: a spoofed header cannot dodge or split the lockout (all share the socket address)", async () => {
    const { base } = start({ limiter: new LoginRateLimiter({ freeAttempts: 2, baseDelayMs: 60_000 }) });
    expect(await failures(base, "1.1.1.1")).toBe(429);
    expect((await login(base, PASSWORD, { "x-forwarded-for": "2.2.2.2" })).status).toBe(429);
  });

  test("trusted: clients behind the proxy are throttled separately", async () => {
    const { base } = start({ trustProxy: true, limiter: new LoginRateLimiter({ freeAttempts: 2, baseDelayMs: 60_000 }) });
    expect(await failures(base, "1.1.1.1")).toBe(429);
    expect((await login(base, PASSWORD, { "x-forwarded-for": "2.2.2.2" })).status).toBe(200);
  });
});
