import { expect, test } from "bun:test";
import { checkError, inZone, instanceHealth, refreshInterval, statusTone, type DashboardResponse } from "./dashboard.ts";

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
