import { expect, test } from "bun:test";
import { checkError, inZone, instanceHealth, loadMapInput, refreshInterval, statusTone, type DashboardResponse } from "./dashboard.ts";

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
