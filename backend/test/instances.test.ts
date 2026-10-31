import { afterEach, describe, expect, test } from "bun:test";
import { startFakeImmich } from "../../core/test/fake-immich.ts";
import { decryptSecret } from "../src/crypto.ts";
import { loggedIn, SECRET, seedUser, startTestServer } from "./helpers.ts";

let stops: Array<() => unknown> = [];
afterEach(() => {
  stops.forEach((s) => s());
  stops = [];
});

async function setup() {
  const t = startTestServer();
  stops.push(t.stop);
  const client = await loggedIn(t.base);
  return { ...t, ...client };
}
const body = (over: Record<string, unknown> = {}) => ({
  alias: "home",
  apiUrl: "http://photos.example/api",
  apiKey: "KEY-123456",
  ...over,
});

describe("instances API", () => {
  test("create encrypts the key and never returns it; list/get omit it too", async () => {
    const { call, store } = await setup();
    const res = await call("POST", "/api/instances", body({ note: " main " }));
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain("KEY-123456");
    const created = JSON.parse(text);
    expect(created).toMatchObject({ alias: "home", apiUrl: "http://photos.example/api", note: "main", isDefault: false });
    expect(created.apiKey).toBeUndefined();
    expect(created.apiKeyEnc).toBeUndefined();

    const enc = (store as any).keys.get(created.id) as Buffer;
    expect(enc.includes(Buffer.from("KEY-123456"))).toBe(false);
    expect(decryptSecret(enc, SECRET)).toBe("KEY-123456");

    expect(await (await call("GET", "/api/instances")).text()).not.toContain("KEY-123456");
    expect(await (await call("GET", `/api/instances/${created.id}`)).text()).not.toContain("KEY-123456");
  });

  test("validation uses the core rules and reports problems without echoing the key", async () => {
    const { call } = await setup();
    for (const bad of [
      body({ alias: "../x" }),
      body({ apiUrl: "ftp://x/api" }),
      body({ apiUrl: "http://u:p@x/api" }),
      body({ apiUrl: "http://x/" }),
      body({ apiKey: "  " }),
      body({ apiKey: 5 }),
    ]) {
      const res = await call("POST", "/api/instances", bad);
      expect(res.status).toBe(400);
    }
    const res = await call("POST", "/api/instances", body({ alias: "../x", apiUrl: "http://u:SECRETPW@x/api" }));
    const text = await res.text();
    expect(JSON.parse(text).problems.length).toBeGreaterThan(0);
    expect(text).not.toContain("SECRETPW");
    expect((await call("POST", "/api/instances", body({ isDefault: "yes" }))).status).toBe(400);
  });

  test("duplicate alias is a 409; trailing slash on the URL is normalized", async () => {
    const { call } = await setup();
    const a = await (await call("POST", "/api/instances", body({ apiUrl: "http://a.example/api/" }))).json();
    expect(a.apiUrl).toBe("http://a.example/api");
    expect((await call("POST", "/api/instances", body())).status).toBe(409);
  });

  test("only one instance is the default", async () => {
    const { call } = await setup();
    const a = await (await call("POST", "/api/instances", body({ isDefault: true }))).json();
    const b = await (await call("POST", "/api/instances", body({ alias: "b", isDefault: true }))).json();
    const list = (await (await call("GET", "/api/instances")).json()).instances as Array<{ id: string; isDefault: boolean }>;
    expect(list.filter((i) => i.isDefault).map((i) => i.id)).toEqual([b.id]);
    const patched = await (await call("PATCH", `/api/instances/${a.id}`, { isDefault: true })).json();
    expect(patched.isDefault).toBe(true);
    const after = (await (await call("GET", "/api/instances")).json()).instances as Array<{ isDefault: boolean }>;
    expect(after.filter((i) => i.isDefault)).toHaveLength(1);
  });

  test("PATCH keeps the key when omitted, replaces it when given, validates merged values", async () => {
    const { call, store } = await setup();
    const a = await (await call("POST", "/api/instances", body())).json();
    const before = (store as any).keys.get(a.id) as Buffer;
    const res = await call("PATCH", `/api/instances/${a.id}`, { note: "x", alias: "renamed" });
    expect(await res.json()).toMatchObject({ alias: "renamed", note: "x" });
    expect((store as any).keys.get(a.id)).toBe(before);
    await call("PATCH", `/api/instances/${a.id}`, { apiKey: "NEW-KEY-9" });
    expect(decryptSecret((store as any).keys.get(a.id), SECRET)).toBe("NEW-KEY-9");
    expect((await call("PATCH", `/api/instances/${a.id}`, { apiUrl: "http://x/nope" })).status).toBe(400);
    expect((await call("PATCH", `/api/instances/${crypto.randomUUID()}`, { note: "x" })).status).toBe(404);
    expect((await call("PATCH", `/api/instances/not-a-uuid`, { note: "x" })).status).toBe(404);
  });

  test("delete works, 404s when missing, and is a clear 409 when a job step uses the instance", async () => {
    const { call, store } = await setup();
    const a = await (await call("POST", "/api/instances", body())).json();
    const b = await (await call("POST", "/api/instances", body({ alias: "b" }))).json();
    (store as any).usedByJobs.add(b.id);
    const blocked = await call("DELETE", `/api/instances/${b.id}`);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).message).toContain("job");
    expect((await call("DELETE", `/api/instances/${a.id}`)).status).toBe(200);
    expect((await call("DELETE", `/api/instances/${a.id}`)).status).toBe(404);
  });

  test("check runs the core check against the instance and stores the result", async () => {
    const fake = startFakeImmich();
    stops.push(fake.stop);
    const { call } = await setup();
    const a = await (await call("POST", "/api/instances", body({ apiUrl: fake.url, apiKey: fake.apiKey }))).json();
    const res = await call("POST", `/api/instances/${a.id}/check`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(fake.apiKey);
    expect(JSON.parse(text)).toMatchObject({ ok: true, alias: "home", version: "v3.3.3" });
    const stored = await (await call("GET", `/api/instances/${a.id}`)).json();
    expect(stored.lastCheck).toMatchObject({ ok: true });
    expect(stored.lastCheckedAt).toBeString();
  });

  test("a failing check is stored, and a wrong key is reported without leaking it", async () => {
    const fake = startFakeImmich();
    stops.push(fake.stop);
    const { call } = await setup();
    const a = await (await call("POST", "/api/instances", body({ apiUrl: fake.url, apiKey: "WRONG-KEY-XYZ" }))).json();
    const res = await call("POST", `/api/instances/${a.id}/check`);
    const text = await res.text();
    expect(text).not.toContain("WRONG-KEY-XYZ");
    expect(JSON.parse(text).ok).toBe(false);
    expect((await (await call("GET", `/api/instances/${a.id}`)).json()).lastCheck.ok).toBe(false);
    expect((await call("POST", `/api/instances/${crypto.randomUUID()}/check`)).status).toBe(404);
  });

  test("a stored key that cannot be decrypted gives a clear 500 without details", async () => {
    const { call, store } = await setup();
    const a = await (await call("POST", "/api/instances", body())).json();
    (store as any).keys.set(a.id, Buffer.alloc(40));
    const res = await call("POST", `/api/instances/${a.id}/check`);
    expect(res.status).toBe(500);
    expect((await res.json()).message).toContain("SECRET_KEY");
  });
});

describe("instance ownership", () => {
  const BOB = "bobs long passphrase";
  async function withBob() {
    const t = await setup();
    await seedUser(t.users, "bob", BOB, "user");
    const bob = await loggedIn(t.base, "bob", BOB);
    return { ...t, bob };
  }

  test("instances are private to their owner", async () => {
    const t = await withBob();
    const created = await (await t.call("POST", "/api/instances", body())).json();
    expect((await (await t.bob.call("GET", "/api/instances")).json()).instances).toEqual([]);
    const missing = await t.call("GET", `/api/instances/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
    const missingBody = await missing.json();
    const id = created.id;
    const attempts: Array<[string, string, unknown?]> = [
      ["GET", `/api/instances/${id}`], ["PATCH", `/api/instances/${id}`, { note: "x" }], ["DELETE", `/api/instances/${id}`], ["POST", `/api/instances/${id}/check`],
    ];
    for (const [method, path, payload] of attempts) {
      const res = await t.bob.call(method, path, payload);
      expect([method, path, res.status]).toEqual([method, path, 404]);
      expect(await res.json()).toEqual(missingBody);
    }
    const still = await (await t.call("GET", `/api/instances/${id}`)).json();
    expect(still).toMatchObject({ alias: "home", note: null });
    expect(still.lastCheck).toBeNull();
  });

  test("two users may share an alias and each have a default", async () => {
    const t = await withBob();
    expect((await t.call("POST", "/api/instances", body({ isDefault: true }))).status).toBe(201);
    expect((await t.bob.call("POST", "/api/instances", body({ isDefault: true }))).status).toBe(201);
    const mine = (await (await t.call("GET", "/api/instances")).json()).instances;
    expect(mine.map((i: any) => [i.alias, i.isDefault])).toEqual([["home", true]]);
    const his = (await (await t.bob.call("GET", "/api/instances")).json()).instances;
    expect(his.map((i: any) => [i.alias, i.isDefault])).toEqual([["home", true]]);
    expect((await t.bob.call("POST", "/api/instances", body())).status).toBe(409);
  });
});
