/** Pure dashboard helpers: response types, refresh cadence, health classification, time formatting. */
import type { ApiClient } from "./api.ts";
import type { MapInput } from "./flow/map.ts";

export type DashboardRunStatus = "queued" | "running" | "completed" | "completed_with_failures" | "failed" | "cancelled" | "interrupted" | "skipped";

export type DashboardResponse = {
  instances: Array<{
    id: string;
    alias: string;
    isDefault: boolean;
    lastCheck: { ok: boolean; versionStatus: "supported" | "unsupported" | "untested" | null; version: string | null; error?: { stage?: string; message: string } | string | null } | null;
    lastCheckedAt: string | null;
  }>;
  recentRuns: Array<{ id: string; jobName: string; status: DashboardRunStatus; trigger: string; dryRun: boolean; createdAt: string; startedAt: string | null; finishedAt: string | null; summary: unknown }>;
  nextScheduled: Array<{ jobId: string; jobName: string; cron: string; timezone: string; nextRun: string | null }>;
  running: Array<{ id: string; jobName: string; startedAt: string | null }>;
  stats: { runsLast7Days: number; failedLast7Days: number };
};

export const FAST_REFRESH_MS = 15_000;
export const SLOW_REFRESH_MS = 60_000;

/** Poll cadence: 15s while a run is running, otherwise 60s. null while the tab is hidden (no polling). */
export const refreshInterval = (hasRunning: boolean, visible: boolean): number | null => (visible ? (hasRunning ? FAST_REFRESH_MS : SLOW_REFRESH_MS) : null);

export type Health = { tone: "ok" | "warn" | "error"; label: string };

/** Immich v3.3+ is required: anything the check calls unsupported is a warning, a failed check an error. */
export function instanceHealth(i: DashboardResponse["instances"][number]): Health {
  if (!i.lastCheck) return { tone: "warn", label: "Never checked" };
  if (!i.lastCheck.ok) return { tone: "error", label: "Check failed" };
  if (i.lastCheck.versionStatus === "unsupported") return { tone: "warn", label: "Unsupported version (Immich v3.3 or newer is required)" };
  if (i.lastCheck.versionStatus === "untested") return { tone: "warn", label: "Version not tested" };
  return { tone: "ok", label: "Healthy" };
}

export type SummaryCards = {
  instances: { total: number; attention: number };
  running: { count: number; first: { id: string; jobName: string } | null };
  next: { jobName: string; nextRun: string; timezone: string } | null;
  week: { runs: number; failed: number };
};

/** The four values of the dashboard's summary cards. An instance needs attention when its health is anything but ok. */
export function summaryCards(d: DashboardResponse): SummaryCards {
  const upcoming = d.nextScheduled
    .flatMap((s) => (s.nextRun ? [{ jobName: s.jobName, nextRun: s.nextRun, timezone: s.timezone }] : []))
    .sort((a, b) => new Date(a.nextRun).getTime() - new Date(b.nextRun).getTime());
  const first = d.running[0];
  return {
    instances: { total: d.instances.length, attention: d.instances.filter((i) => instanceHealth(i).tone !== "ok").length },
    running: { count: d.running.length, first: first ? { id: first.id, jobName: first.jobName } : null },
    next: upcoming[0] ?? null,
    week: { runs: d.stats.runsLast7Days, failed: d.stats.failedLast7Days },
  };
}

export const checkError = (i: DashboardResponse["instances"][number]): string | null => {
  const e = i.lastCheck?.error;
  return !e ? null : typeof e === "string" ? e : e.message;
};

/** A time in a named IANA zone; falls back to ISO text if the zone is unknown. */
export function inZone(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export const statusTone = (s: string): "success" | "error" | "warning" | "neutral" | "primary" =>
  s === "completed" ? "success" : s === "failed" || s === "interrupted" ? "error" : s === "completed_with_failures" || s === "cancelled" ? "warning" : s === "skipped" ? "neutral" : "primary";

/** The slice of the API client that the dashboard map needs (kept small so tests can fake it). */
export type MapApi = Pick<ApiClient, "request" | "listInstances" | "listJobs" | "listRuns" | "getRun">;

/** Everything the dashboard shows: the summary plus the inputs for the instance map. All calls are scoped to the signed-in user by the backend. */
export async function loadMapInput(api: MapApi): Promise<{ dashboard: DashboardResponse; map: MapInput }> {
  const [dashboard, instances, jobs, queued] = await Promise.all([
    api.request<DashboardResponse>("GET", "/api/dashboard"),
    api.listInstances(),
    api.listJobs(),
    api.listRuns({ limit: 20, offset: 0, status: "queued" }),
  ]);
  const latest = await Promise.all(jobs.map((j) => api.listRuns({ limit: 1, offset: 0, jobId: j.id })));
  const lastResults: MapInput["lastResults"] = {};
  jobs.forEach((j, i) => {
    const r = latest[i].runs[0];
    lastResults[j.id] = r ? { status: r.status, finishedAt: r.finishedAt } : null;
  });
  const running = await Promise.all(dashboard.running.map((r) => api.getRun(r.id).catch(() => null)));
  const active: MapInput["active"] = [
    ...running.flatMap((run) => (run ? [{ run, percent: null, queued: false }] : [])),
    ...queued.runs.map((run) => ({ run, percent: null, queued: true })),
  ];
  return { dashboard, map: { instances, jobs, lastResults, active } };
}
