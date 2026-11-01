import { expect, test } from "bun:test";
import { checkError, inZone, instanceHealth, loadMapInput, refreshInterval, statusTone, summaryCards, type DashboardResponse } from "./dashboard.ts";

const inst = (lastCheck: DashboardResponse["instances"][number]["lastCheck"]) => ({ id: "1", alias: "a", isDefault: false, lastCheck, lastCheckedAt: null });

test("refresh cadence: 15s with a running run, 60s idle, none when hidden", () => {
  expect(refreshInterval(true, true)).toBe(15_000);
  expect(refreshInterval(false, true)).toBe(60_000);
  expect(refreshInterval(true, false)).toBeNull();
});

test("instance health", () => {
  expect(instanceHealth(inst(null)).label).toBe("Never checked");
  expect(instanceHealth(inst({ ok: false, versionStatus: null, version: null, error: { message: "down" } })).tone).toBe("error");
  expect(instanceHealth(inst({ ok: true, versionStatus: "unsupported", version: "3.2.0" })).tone).toBe("warn");
  expect(instanceHealth(inst({ ok: true, versionStatus: "supported", version: "3.3.0" })).tone).toBe("ok");
  expect(checkError(inst({ ok: false, versionStatus: null, version: null, error: "x" }))).toBe("x");
});

test("zone formatting and status tones", () => {
  expect(inZone("2026-01-01T00:00:00Z", "Pacific/Auckland")).toContain("2026");
  expect(inZone("2026-01-01T00:00:00Z", "Not/AZone")).toBe("2026-01-01T00:00:00Z");
  expect(statusTone("skipped")).toBe("neutral");
  expect(statusTone("failed")).toBe("error");
});

test("loadMapInput loads one latest run per job and the queued/running runs", async () => {
  const calls: unknown[] = [];
  const run = (id: string, status: string, jobId: string) => ({ id, status, finishedAt: null, settings: { jobId, name: "n", dryRun: false, steps: [] }, steps: [] }) as never;
  const api = {
    request: async () => ({ instances: [], recentRuns: [], nextScheduled: [], running: [{ id: "r-live", jobName: "A", startedAt: null }], stats: { runsLast7Days: 0, failedLast7Days: 0 } }),
    listInstances: async () => [],
    listJobs: async () => [{ id: "ja" }, { id: "jb" }] as never,
    listRuns: async (q: { limit: number; offset: number; status?: string; jobId?: string }) => {
      calls.push(q);
      if (q.status === "queued") return { runs: [run("r-q", "queued", "jb")], total: 1, limit: 20, offset: 0 };
      return { runs: q.jobId === "ja" ? [{ ...run("r1", "completed", "ja"), finishedAt: "2026-10-30T00:00:00Z" }] : [], total: 0, limit: 1, offset: 0 };
    },
    getRun: async (id: string) => run(id, "running", "ja"),
  };
  const { dashboard, map } = await loadMapInput(api);
  expect(dashboard.running).toHaveLength(1);
  expect(calls.filter((c) => (c as { limit: number }).limit === 1)).toEqual([
    { limit: 1, offset: 0, jobId: "ja" },
    { limit: 1, offset: 0, jobId: "jb" },
  ]);
  expect(map.lastResults).toEqual({ ja: { status: "completed", finishedAt: "2026-10-30T00:00:00Z" }, jb: null });
  expect(map.active.map((a) => [a.run.id, a.queued])).toEqual([["r-live", false], ["r-q", true]]);
});

test("summaryCards counts instances that need attention, running runs, the earliest next run and the week", () => {
  const ok = { ok: true, versionStatus: "supported" as const, version: "3.3.5" };
  const data = {
    instances: [
      { id: "1", alias: "a", isDefault: true, lastCheck: ok, lastCheckedAt: null },
      { id: "2", alias: "b", isDefault: false, lastCheck: null, lastCheckedAt: null },
      { id: "3", alias: "c", isDefault: false, lastCheck: { ok: true, versionStatus: "unsupported" as const, version: "3.2.4" }, lastCheckedAt: null },
      { id: "4", alias: "d", isDefault: false, lastCheck: { ok: false, versionStatus: null, version: null, error: "down" }, lastCheckedAt: null },
    ],
    recentRuns: [],
    nextScheduled: [
      { jobId: "j1", jobName: "Later", cron: "0 3 * * *", timezone: "UTC", nextRun: "2026-11-02T03:00:00Z" },
      { jobId: "j2", jobName: "Sooner", cron: "0 1 * * *", timezone: "Europe/Lisbon", nextRun: "2026-11-02T01:00:00Z" },
      { jobId: "j3", jobName: "No next run", cron: "0 0 * * *", timezone: "UTC", nextRun: null },
    ],
    running: [{ id: "r1", jobName: "Nightly", startedAt: null }, { id: "r2", jobName: "Other", startedAt: null }],
    stats: { runsLast7Days: 23, failedLast7Days: 1 },
  } as DashboardResponse;

  expect(summaryCards(data)).toEqual({
    instances: { total: 4, attention: 3 },
    running: { count: 2, first: { id: "r1", jobName: "Nightly" } },
    next: { jobName: "Sooner", nextRun: "2026-11-02T01:00:00Z", timezone: "Europe/Lisbon" },
    week: { runs: 23, failed: 1 },
  });
});

test("summaryCards with nothing going on", () => {
  const empty = { instances: [], recentRuns: [], nextScheduled: [], running: [], stats: { runsLast7Days: 0, failedLast7Days: 0 } } as DashboardResponse;
  expect(summaryCards(empty)).toEqual({
    instances: { total: 0, attention: 0 },
    running: { count: 0, first: null },
    next: null,
    week: { runs: 0, failed: 0 },
  });
});
