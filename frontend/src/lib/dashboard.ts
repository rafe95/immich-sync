/** Pure dashboard helpers: response types, refresh cadence, health classification, time formatting. */

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
