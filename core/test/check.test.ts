import { afterEach, describe, expect, test } from "bun:test";
import { checkInstance } from "../src/check.ts";
import { startFakeImmich } from "./fake-immich.ts";

let stops: Array<() => void> = [];
afterEach(() => {
  stops.forEach((s) => s());
  stops = [];
});

function fake(options: Parameters<typeof startFakeImmich>[0] = {}) {
  const f = startFakeImmich(options);
  stops.push(f.stop);
  return f;
}

describe("checkInstance", () => {
  test("a reachable v3.3 server with an all-permissions key passes every role", async () => {
    const f = fake();
    const r = await checkInstance({ alias: "home", apiUrl: f.url, apiKey: f.apiKey });
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
    expect(r.version).toBe("v3.3.3");
    expect(r.versionStatus).toBe("supported");
    expect(r.user?.email).toBe("owner@example.com");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Object.values(r.roles!).every((role) => role.ok)).toBe(true);
  });

  test("a trailing slash in the URL is tolerated", async () => {
    const f = fake();
    const r = await checkInstance({ alias: "home", apiUrl: `${f.url}/`, apiKey: f.apiKey });
    expect(r.ok).toBe(true);
  });

  test("an unreachable server fails at the ping stage", async () => {
    const r = await checkInstance({ alias: "gone", apiUrl: "http://127.0.0.1:9/api", apiKey: "x" });
    expect(r.ok).toBe(false);
    expect(r.error?.stage).toBe("ping");
  });

  test("a wrong key fails at the key stage and names the HTTP status", async () => {
    const f = fake();
    const r = await checkInstance({ alias: "home", apiUrl: f.url, apiKey: "wrong" });
    expect(r.ok).toBe(false);
    expect(r.error?.stage).toBe("key");
    expect(r.error?.message).toContain("401");
    expect(r.version).toBe("v3.3.3");
  });

  test("Immich older than v3.3 is refused", async () => {
    const f = fake({ version: { major: 3, minor: 2, patch: 4 } });
    const r = await checkInstance({ alias: "old", apiUrl: f.url, apiKey: f.apiKey });
    expect(r.ok).toBe(false);
    expect(r.error?.stage).toBe("version");
    expect(r.versionStatus).toBe("unsupported");
  });

  test("Immich newer than the tested range passes with a warning", async () => {
    const f = fake({ version: { major: 3, minor: 9, patch: 0 } });
    const r = await checkInstance({ alias: "new", apiUrl: f.url, apiKey: f.apiKey });
    expect(r.ok).toBe(true);
    expect(r.versionStatus).toBe("untested");
    expect(r.warnings[0]).toContain("v3.9.0");
  });

  test("a read-only key is fine as a copy source but not for move or as a target", async () => {
    const f = fake({ permissions: ["user.read", "asset.read", "asset.view", "asset.download"] });
    const r = await checkInstance({ alias: "ro", apiUrl: f.url, apiKey: f.apiKey });
    expect(r.ok).toBe(true);
    expect(r.roles!["source-copy"].ok).toBe(true);
    expect(r.roles!["source-move"]).toEqual({ ok: false, missing: ["asset.delete"] });
    expect(r.roles!["target-copy"].missing).toEqual(["asset.upload"]);
  });
});
