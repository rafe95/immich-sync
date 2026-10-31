import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memorySessionStore } from "../src/auth/sessions.ts";
import { memoryInstanceStore } from "../src/instances/store.ts";
import { memoryJobStore } from "../src/jobs/store.ts";
import { unwiredExecutor } from "../src/runs/executor.ts";
import { memoryRunStore } from "../src/runs/store.ts";
import { createJobRunServices } from "../src/services.ts";
import { createServer } from "../src/server.ts";

let staticDir: string;
let up = true;
let server: ReturnType<typeof createServer>;
let base: string;

beforeAll(async () => {
  staticDir = await mkdtemp(join(tmpdir(), "immich-sync-static-"));
  await writeFile(join(staticDir, "index.html"), "<html>app</html>");
  await writeFile(join(staticDir, "app.js"), "console.log(1)");
  const instanceStore = memoryInstanceStore();
  const svc = createJobRunServices({ instances: instanceStore, jobs: memoryJobStore(), runs: memoryRunStore(), executor: unwiredExecutor });
  server = createServer({
    port: 0,
    staticDir,
    db: { ping: async () => up },
    auth: { adminPassword: "pw", sessions: memorySessionStore() },
    instances: { store: instanceStore, secretKey: "k".repeat(32) },
    jobs: svc.jobs,
    runs: svc.runs,
    dashboard: svc.dashboard,
    settings: svc.settings,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  await rm(staticDir, { recursive: true });
});

describe("server", () => {
  test("health reports the database state", async () => {
    up = true;
    let res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", database: true });

    up = false;
    res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded", database: false });
  });

  test("unknown API routes are JSON 401s without a session, never the app", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Authentication required." });
  });

  test("static files are served, other paths fall back to index.html", async () => {
    expect(await (await fetch(`${base}/app.js`)).text()).toBe("console.log(1)");
    expect(await (await fetch(`${base}/history/123`)).text()).toBe("<html>app</html>");
  });

  test("paths cannot escape the static folder", async () => {
    const res = await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`);
    expect(await res.text()).toBe("<html>app</html>");
  });
});
