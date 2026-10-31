import { memorySessionStore } from "../src/auth/sessions.ts";
import { LoginRateLimiter } from "../src/auth/rate-limit.ts";
import { memoryInstanceStore, type InstanceStore } from "../src/instances/store.ts";
import { memoryJobStore, type JobStore } from "../src/jobs/store.ts";
import { memoryRunStore, type RunStore } from "../src/runs/store.ts";
import { unwiredExecutor, type StepExecutor } from "../src/runs/executor.ts";
import { createJobRunServices } from "../src/services.ts";
import { createServer, type ServerDeps } from "../src/server.ts";
import type { SessionStore } from "../src/auth/sessions.ts";

export const PASSWORD = "correct horse battery";
export const SECRET = "s".repeat(40);

export function startTestServer(overrides: {
  instances?: Partial<ServerDeps["instances"]>;
  store?: InstanceStore;
  sessions?: SessionStore;
  limiter?: LoginRateLimiter;
  secureCookies?: boolean | "auto";
  jobStore?: JobStore;
  runStore?: RunStore;
  executor?: StepExecutor;
  heartbeatMs?: number;
  defaultTimezone?: string;
} = {}) {
  const store = overrides.store ?? memoryInstanceStore();
  const jobStore = overrides.jobStore ?? memoryJobStore();
  const runStore = overrides.runStore ?? memoryRunStore();
  const svc = createJobRunServices({
    instances: store, jobs: jobStore, runs: runStore, executor: overrides.executor ?? unwiredExecutor,
    heartbeatMs: overrides.heartbeatMs, defaultTimezone: overrides.defaultTimezone ?? "UTC",
  });
  const server = createServer({
    port: 0,
    staticDir: null,
    db: { ping: async () => true },
    auth: {
      adminPassword: PASSWORD,
      sessions: overrides.sessions ?? memorySessionStore(),
      limiter: overrides.limiter,
      secureCookies: overrides.secureCookies,
    },
    instances: { store, secretKey: SECRET, ...overrides.instances },
    jobs: svc.jobs,
    runs: svc.runs,
  });
  const base = `http://127.0.0.1:${server.port}`;
  return { server, base, store, jobStore, runStore, manager: svc.manager, stop: () => server.stop(true) };
}

/** Logs in and returns a small client that sends cookie + CSRF token. */
export async function loggedIn(base: string) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { cookie, "x-csrf-token": csrfToken, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as Promise<Omit<Response, "json"> & { json(): Promise<any> }>;
  return { cookie, csrfToken, call };
}
