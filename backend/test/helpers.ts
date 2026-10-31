import { memorySessionStore } from "../src/auth/sessions.ts";
import { LoginRateLimiter } from "../src/auth/rate-limit.ts";
import { memoryInstanceStore, type InstanceStore } from "../src/instances/store.ts";
import { memoryJobStore, type JobStore } from "../src/jobs/store.ts";
import { memoryRunStore, type RunStore } from "../src/runs/store.ts";
import { unwiredExecutor, type StepExecutor } from "../src/runs/executor.ts";
import { createJobRunServices } from "../src/services.ts";
import { createServer, type ServerDeps } from "../src/server.ts";
import { hashPassword } from "../src/auth/auth.ts";
import { memoryUserStore, type Role, type UserStore } from "../src/auth/users.ts";
import type { SessionStore } from "../src/auth/sessions.ts";

export const PASSWORD = "correct horse battery";
export const USERNAME = "admin";
// One argon2 hash shared by all test servers keeps the suite fast.
const ADMIN_HASH = await hashPassword(PASSWORD);
export const SECRET = "s".repeat(40);

export function startTestServer(overrides: {
  instances?: Partial<ServerDeps["instances"]>;
  store?: InstanceStore;
  sessions?: SessionStore;
  limiter?: LoginRateLimiter;
  secureCookies?: boolean | "auto";
  trustProxy?: boolean;
  users?: UserStore;
  /** Create the default admin (USERNAME/PASSWORD) before starting; default true. Set false to test first-run setup. */
  seedAdmin?: boolean;
  jobStore?: JobStore;
  runStore?: RunStore;
  executor?: StepExecutor;
  heartbeatMs?: number;
  defaultTimezone?: string;
} = {}) {
  const users = overrides.users ?? memoryUserStore();
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
      users,
      sessions: overrides.sessions ?? memorySessionStore(),
      limiter: overrides.limiter,
      secureCookies: overrides.secureCookies,
    },
    instances: { store, secretKey: SECRET, ...overrides.instances },
    jobs: svc.jobs,
    runs: svc.runs,
    dashboard: svc.dashboard,
    settings: svc.settings,
    trustProxy: overrides.trustProxy,
  });
  const base = `http://127.0.0.1:${server.port}`;
  let adminId = "";
  let isReady = overrides.seedAdmin === false;
  const ready: Promise<unknown> = overrides.seedAdmin === false ? Promise.resolve() : users.create(USERNAME, ADMIN_HASH, "admin").then((u) => void ((adminId = u.id), (isReady = true)));
  return {
    server, base, users, ready,
    /** The seeded admin's id; throws if read before `ready` has resolved (empty when seedAdmin is false). */
    get adminId() {
      if (!isReady) throw new Error("adminId read before `ready` resolved: await t.ready first.");
      return adminId;
    },
    store, jobStore, runStore, manager: svc.manager, stop: () => server.stop(true),
  };
}

export async function seedUser(users: UserStore, username: string, password: string, role: Role) {
  return users.create(username, await hashPassword(password), role);
}

/** Logs in and returns a small client that sends cookie + CSRF token. */
export async function loggedIn(base: string, username = USERNAME, password = PASSWORD) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const { csrfToken, user } = (await res.json()) as { csrfToken: string; user: { id: string; username: string; role: string } };
  const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { cookie, "x-csrf-token": csrfToken, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as Promise<Omit<Response, "json"> & { json(): Promise<any> }>;
  return { cookie, csrfToken, user, call };
}
