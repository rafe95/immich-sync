/** Typed calls to the backend API. The browser only ever talks to this API, never to Immich. */

import type { JobRecord, ScheduleInput, ScheduleRecord } from "./jobs.ts";
import type { Run, RunEvent, RunStatus } from "./runs.ts";

export type Health = { status: "ok" | "degraded"; database: boolean; version: string };

export type Role = "source-copy" | "source-move" | "source-metadata" | string;
export type InstanceCheck = {
  alias: string;
  ok: boolean;
  checkedAt: string;
  latencyMs: number | null;
  version: string | null;
  versionStatus: "supported" | "unsupported" | "untested" | null;
  user: { id: string; email: string; name: string } | null;
  permissions: string[];
  roles: Record<string, { ok: boolean; missing: string[] }> | null;
  error: { stage: "ping" | "version" | "key" | "permissions"; message: string } | null;
  warnings: string[];
};
export type Instance = {
  id: string;
  alias: string;
  apiUrl: string;
  note: string | null;
  isDefault: boolean;
  lastCheck: InstanceCheck | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type InstanceInput = { alias?: string; apiUrl?: string; apiKey?: string; note?: string | null; isDefault?: boolean };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
  }
}

export type ApiClientOptions = {
  fetch?: typeof fetch;
  /** Called after a 401 (session missing or expired); the CSRF token has already been cleared. */
  onUnauthorized?: () => void;
};

export function createApiClient(options: ApiClientOptions = {}) {
  // The CSRF token lives in memory only: never localStorage, never a cookie we set.
  let csrfToken: string | null = null;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET" && method !== "HEAD" && csrfToken) headers["x-csrf-token"] = csrfToken;
    const doFetch = options.fetch ?? fetch;
    const res = await doFetch(path, {
      method,
      headers,
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      if (res.status === 401) {
        csrfToken = null;
        options.onUnauthorized?.();
      }
      const problems = Array.isArray(data?.problems) ? (data.problems as string[]) : [];
      throw new ApiError(res.status, typeof data?.message === "string" ? data.message : `HTTP ${res.status}`, problems);
    }
    return data as T;
  }

  const remember = (r: { csrfToken: string }) => {
    csrfToken = r.csrfToken;
  };

  return {
    request,
    hasCsrfToken: () => csrfToken !== null,
    async login(password: string) {
      const r = await request<{ csrfToken: string }>("POST", "/api/auth/login", { password });
      remember(r);
    },
    async me(): Promise<boolean> {
      try {
        remember(await request<{ csrfToken: string }>("GET", "/api/auth/me"));
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return false;
        throw err;
      }
    },
    async logout() {
      try {
        await request("POST", "/api/auth/logout");
      } finally {
        csrfToken = null;
      }
    },
    listInstances: async () => (await request<{ instances: Instance[] }>("GET", "/api/instances")).instances,
    createInstance: (input: InstanceInput) => request<Instance>("POST", "/api/instances", input),
    updateInstance: (id: string, input: InstanceInput) => request<Instance>("PATCH", `/api/instances/${id}`, input),
    deleteInstance: (id: string) => request<{ deleted: true }>("DELETE", `/api/instances/${id}`),
    checkInstance: (id: string) => request<InstanceCheck>("POST", `/api/instances/${id}/check`),
    listJobs: async () => (await request<{ jobs: JobRecord[] }>("GET", "/api/jobs")).jobs,
    createJob: (body: Record<string, unknown>) => request<JobRecord>("POST", "/api/jobs", body),
    updateJob: (id: string, body: Record<string, unknown>) => request<JobRecord>("PATCH", `/api/jobs/${id}`, body),
    deleteJob: (id: string) => request<{ deleted: true }>("DELETE", `/api/jobs/${id}`),
    runJob: (id: string, dryRun: boolean) => request<Run>("POST", `/api/jobs/${id}/run`, { dryRun }),
    getSchedule: (jobId: string) => request<ScheduleRecord>("GET", `/api/jobs/${jobId}/schedule`),
    putSchedule: (jobId: string, body: ScheduleInput) => request<ScheduleRecord>("PUT", `/api/jobs/${jobId}/schedule`, body),
    deleteSchedule: (jobId: string) => request<{ deleted: true }>("DELETE", `/api/jobs/${jobId}/schedule`),
    listSchedules: async () => (await request<{ schedules: ScheduleRecord[] }>("GET", "/api/schedules")).schedules,
    startRun: (body: Record<string, unknown>) => request<Run>("POST", "/api/runs", body),
    getRun: (id: string) => request<Run>("GET", `/api/runs/${id}`),
    cancelRun: (id: string) => request<{ cancelling: true }>("POST", `/api/runs/${id}/cancel`),
    listRuns: (q: { limit: number; offset: number; status?: RunStatus | ""; jobId?: string }) => {
      const p = new URLSearchParams({ limit: String(q.limit), offset: String(q.offset) });
      if (q.status) p.set("status", q.status);
      if (q.jobId) p.set("jobId", q.jobId);
      return request<{ runs: Run[]; total: number; limit: number; offset: number }>("GET", `/api/runs?${p}`);
    },
    getRunLog: (id: string, after: number, limit = 1000) =>
      request<{ events: RunEvent[]; nextAfter: number | null }>("GET", `/api/runs/${id}/log?after=${after}&limit=${limit}`),
    /** The whole stored log, fetched page by page. */
    async getFullRunLog(id: string, onPage?: (events: RunEvent[]) => void): Promise<RunEvent[]> {
      const all: RunEvent[] = [];
      let after = 0;
      for (;;) {
        const page = await request<{ events: RunEvent[]; nextAfter: number | null }>("GET", `/api/runs/${id}/log?after=${after}&limit=1000`);
        all.push(...page.events);
        onPage?.(page.events);
        if (page.events.length < 1000 || page.nextAfter === null) return all;
        after = page.nextAfter;
      }
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export async function getHealth(): Promise<Health> {
  const res = await fetch("/api/health");
  if (!res.ok && res.status !== 503) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Health;
}
