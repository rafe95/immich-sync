/** GET /api/dashboard: one read-only summary for the Dashboard screen. Never includes API keys, URLs or raw check payloads. */

import { Cron } from "croner";
import { json } from "./http.ts";
import type { InstanceStore } from "./instances/store.ts";
import type { JobStore } from "./jobs/store.ts";
import { hasMoveStep } from "./jobs/validation.ts";
import type { RunStore } from "./runs/store.ts";

export type DashboardDeps = {
  instances: Pick<InstanceStore, "list">;
  jobs: Pick<JobStore, "list">;
  runs: Pick<RunStore, "listRuns" | "statsSince">;
  now?: () => Date;
};

type StoredCheck = { ok?: unknown; version?: unknown; versionStatus?: unknown; error?: { message?: unknown } | null };

function lastCheckView(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as StoredCheck;
  const out: { ok: boolean; versionStatus: string | null; version: string | null; error?: string } = {
    ok: c.ok === true,
    versionStatus: typeof c.versionStatus === "string" ? c.versionStatus : null,
    version: typeof c.version === "string" ? c.version : null,
  };
  if (c.error && typeof c.error.message === "string") out.error = c.error.message;
  return out;
}

export function createDashboardRoutes(deps: DashboardDeps) {
  const now = deps.now ?? (() => new Date());
  return {
    get: async (_req: Request, ctx: { user: { id: string } }) => {
      const at = now();
      const [instances, jobs, recent, running, stats] = await Promise.all([
        deps.instances.list(ctx.user.id),
        deps.jobs.list(ctx.user.id),
        deps.runs.listRuns(ctx.user.id, { limit: 10, offset: 0 }),
        deps.runs.listRuns(ctx.user.id, { limit: 100, offset: 0, status: "running" }),
        deps.runs.statsSince(ctx.user.id, new Date(at.getTime() - 7 * 86_400_000)),
      ]);

      const nextScheduled = jobs
        // A move job without confirmation would be skipped when due, so it is not listed as upcoming.
        .filter((j) => j.schedule?.enabled && (!hasMoveStep(j.steps) || j.schedule.moveConfirmedAt))
        .flatMap((j) => {
          const s = j.schedule!;
          try {
            const next = new Cron(s.cron, { timezone: s.timezone, paused: true }).nextRun(at);
            return next ? [{ jobId: j.id, jobName: j.name, cron: s.cron, timezone: s.timezone, nextRun: next.toISOString() }] : [];
          } catch {
            return []; // unusable cron or time zone: the scheduler logs it
          }
        })
        .sort((a, b) => a.nextRun.localeCompare(b.nextRun))
        .slice(0, 5);

      return json({
        instances: instances.map((i) => ({ id: i.id, alias: i.alias, isDefault: i.isDefault, lastCheck: lastCheckView(i.lastCheck), lastCheckedAt: i.lastCheckedAt })),
        recentRuns: recent.runs.map((r) => ({
          id: r.id, jobName: r.jobName, status: r.status, trigger: r.trigger, dryRun: r.dryRun,
          createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt, summary: r.summary,
        })),
        nextScheduled,
        running: running.runs.map((r) => ({ id: r.id, jobName: r.jobName, startedAt: r.startedAt })),
        stats: { runsLast7Days: stats.runs, failedLast7Days: stats.failed },
      });
    },
  };
}
