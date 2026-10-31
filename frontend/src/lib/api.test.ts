import { expect, test } from "bun:test";
import { ApiError, createApiClient } from "./api.ts";

type Call = { url: string; init: RequestInit };
function fake(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const hdr = (c: Call, k: string) => (c.init.headers as Record<string, string>)[k];

test("login stores csrf token and sends it on non-GET only, with cookies", async () => {
  const { f, calls } = fake([
    { status: 200, body: { csrfToken: "tok" } },
    { status: 200, body: { instances: [] } },
    { status: 200, body: { deleted: true } },
  ]);
  const api = createApiClient({ fetch: f });
  await api.login("alice", "pw");
  expect(hdr(calls[0]!, "x-csrf-token")).toBeUndefined(); // nothing known yet
  await api.listInstances();
  await api.deleteInstance("id1");
  expect(hdr(calls[1]!, "x-csrf-token")).toBeUndefined();
  expect(hdr(calls[2]!, "x-csrf-token")).toBe("tok");
  expect(calls.every((c) => c.init.credentials === "include")).toBe(true);
});

test("me() returns false on 401 and does not throw; refreshes token on success", async () => {
  const a = fake([{ status: 401, body: { message: "Authentication required." } }]);
  expect(await createApiClient({ fetch: a.f }).me()).toBeNull();
  const b = fake([{ status: 200, body: { csrfToken: "t2", user: { id: "1", username: "a", role: "admin" } } }, { status: 200, body: {} }]);
  const api = createApiClient({ fetch: b.f });
  expect((await api.me())?.user?.role).toBe("admin");
  await api.request("POST", "/api/x", {});
  expect(hdr(b.calls[1]!, "x-csrf-token")).toBe("t2");
});

test("401 clears the token, calls onUnauthorized and throws ApiError", async () => {
  let redirected = 0;
  const { f } = fake([
    { status: 200, body: { csrfToken: "tok" } },
    { status: 401, body: { message: "Authentication required." } },
  ]);
  const api = createApiClient({ fetch: f, onUnauthorized: () => redirected++ });
  await api.login("alice", "pw");
  expect(api.hasCsrfToken()).toBe(true);
  const err = await api.listInstances().catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(401);
  expect(redirected).toBe(1);
  expect(api.hasCsrfToken()).toBe(false);
});

test("error responses surface message and validation problems", async () => {
  const { f } = fake([{ status: 400, body: { message: "Invalid instance.", problems: ["bad url"] } }]);
  const err = await createApiClient({ fetch: f }).createInstance({}).catch((e) => e);
  expect(err.message).toBe("Invalid instance.");
  expect(err.problems).toEqual(["bad url"]);
});

test("logout clears the token even when the request fails", async () => {
  const { f } = fake([{ status: 200, body: { csrfToken: "t" } }, { status: 500, body: { message: "boom" } }]);
  const api = createApiClient({ fetch: f });
  await api.login("alice", "pw");
  await api.logout().catch(() => {});
  expect(api.hasCsrfToken()).toBe(false);
});

test("login sends username and password; needsSetup is surfaced on the error", async () => {
  const a = fake([{ status: 200, body: { authenticated: true, csrfToken: "t", user: { id: "1", username: "alice", role: "admin" } } }]);
  const user = await createApiClient({ fetch: a.f }).login("alice", "pw");
  expect(JSON.parse(a.calls[0]!.init.body as string)).toEqual({ username: "alice", password: "pw" });
  expect(user).toEqual({ id: "1", username: "alice", role: "admin" });
  const b = fake([{ status: 409, body: { message: "No account yet.", needsSetup: true } }]);
  const err = await createApiClient({ fetch: b.f }).login("a", "b").catch((e) => e);
  expect(err.needsSetup).toBe(true);
});

test("user deletion preview gets counts and propagates errors", async () => {
  const { f, calls } = fake([
    { status: 200, body: { instances: 2, jobs: 3, runs: 4 } },
    { status: 404, body: { message: "User not found." } },
  ]);
  const api = createApiClient({ fetch: f });
  expect(await api.getUserData("a b")).toEqual({ instances: 2, jobs: 3, runs: 4 });
  expect(calls[0]!.url).toBe("/api/users/a%20b/data");
  expect(calls[0]!.init.method).toBe("GET");
  await expect(api.getUserData("missing")).rejects.toMatchObject({ status: 404, message: "User not found." });
});

test("setup stores the csrf token and user admin calls use the contract paths", async () => {
  const { f, calls } = fake([
    { status: 201, body: { authenticated: true, csrfToken: "s", user: { id: "1", username: "root", role: "admin" } } },
    { status: 200, body: { users: [] } },
    { status: 200, body: {} },
  ]);
  const api = createApiClient({ fetch: f });
  expect((await api.setup("root", "pw")) ?.username).toBe("root");
  await api.listUsers();
  await api.deleteUser("a b");
  expect(calls[0]!.url).toBe("/api/setup");
  expect(calls[2]!.url).toBe("/api/users/a%20b");
  expect(hdr(calls[2]!, "x-csrf-token")).toBe("s");
});
