import { afterEach, describe, expect, test } from "bun:test";
import { LoginRateLimiter } from "../src/auth/rate-limit.ts";
import { createAuth, safeEqual } from "../src/auth/auth.ts";
import { memorySessionStore } from "../src/auth/sessions.ts";
import { loggedIn, PASSWORD, startTestServer } from "./helpers.ts";

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
const login = (base: string, password: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ password }), headers });

describe("auth", () => {
  test("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  test("fails closed without an admin password", () => {
    expect(() => createAuth({ adminPassword: "", sessions: memorySessionStore() })).toThrow();
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
    expect(await me.json()).toEqual({ authenticated: true, csrfToken });

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
    const auth = createAuth({ adminPassword: PASSWORD, sessions, now: () => new Date(now) });
    const res = await auth.login(new Request("http://x/api/auth/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }) }), "c");
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
