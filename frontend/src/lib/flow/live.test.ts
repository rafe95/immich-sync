import { describe, expect, test } from "bun:test";
import { initialConsole, reduceEvents, type ConsoleState, type Run, type RunEvent } from "../runs.ts";
import { countsText, currentStepOf, livePercents, recentLines, withLivePercents } from "./live.ts";
import type { MapInput } from "./map.ts";

const run = (id: string, steps: Array<{ position: number; status: string }> = [{ position: 1, status: "running" }]): Run =>
  ({
    id, jobName: "Nightly", trigger: "manual", dryRun: false, status: "running",
    settings: { jobId: "j", name: "Nightly", dryRun: false, steps: [] }, summary: null, createdAt: "", startedAt: null, finishedAt: null,
    steps: steps.map((s) => ({ ...s, summary: null, startedAt: null, finishedAt: null })),
  }) as Run;

let nextId = 1;
const ev = (type: string, data: unknown, message: string | null = null): RunEvent => ({ id: nextId++, runId: "r1", ts: "2026-11-01T00:00:00Z", level: "info", type, message, data });
const progress = (done: number, total: number | null, step?: number) => ev("progress", { done, total, ...(step === undefined ? {} : { step }) });
const asset = (fileName: string, outcome: string) => ev("asset", { fileName, outcome, step: 1 });
const stateOf = (events: RunEvent[]): ConsoleState => reduceEvents(initialConsole(), events);

describe("currentStepOf", () => {
  test("the running step's position, else null", () => {
    expect(currentStepOf(run("r", [{ position: 1, status: "completed" }, { position: 2, status: "running" }]))).toBe(2);
    expect(currentStepOf(run("r", [{ position: 1, status: "pending" }]))).toBeNull();
  });
});

describe("livePercents", () => {
  const active = (...runs: Array<{ run: Run; queued?: boolean }>): MapInput["active"] => runs.map((r) => ({ run: r.run, percent: null, queued: r.queued ?? false }));

  test("uses the latest progress for the running step", () => {
    const s = stateOf([progress(30, 100, 1), progress(62, 100, 1)]);
    expect(livePercents(active({ run: run("r1") }), () => s)).toEqual({ r1: 62 });
  });

  test("progress without a step belongs to the running step", () => {
    const s = stateOf([progress(1, 4)]);
    expect(livePercents(active({ run: run("r1") }), () => s)).toEqual({ r1: 25 });
  });

  test("progress of a finished step does not leak onto the running one", () => {
    const r = run("r1", [{ position: 1, status: "completed" }, { position: 2, status: "running" }]);
    const s = stateOf([progress(100, 100, 1)]);
    expect(livePercents(active({ run: r }), () => s)).toEqual({});
  });

  test("skips queued runs, runs without a stream yet, unknown totals and runs with no running step", () => {
    const s = stateOf([progress(5, null, 1)]);
    expect(livePercents(active({ run: run("q"), queued: true }), () => s)).toEqual({});
    expect(livePercents(active({ run: run("r1") }), () => undefined)).toEqual({});
    expect(livePercents(active({ run: run("r1") }), () => s)).toEqual({});
    expect(livePercents(active({ run: run("p", [{ position: 1, status: "pending" }]) }), () => stateOf([progress(1, 2)]))).toEqual({});
  });
});

describe("withLivePercents", () => {
  const base = (): MapInput => ({
    instances: [], jobs: [], lastResults: {},
    active: [
      { run: run("r1"), percent: null, queued: false },
      { run: run("r2"), percent: 7, queued: false },
    ],
  });

  test("overrides only the listed runs and leaves the input untouched", () => {
    const input = base();
    const out = withLivePercents(input, { r1: 40 });
    expect(out.active.map((a) => a.percent)).toEqual([40, 7]);
    expect(input.active.map((a) => a.percent)).toEqual([null, 7]);
  });

  test("no live percents returns the same input", () => {
    const input = base();
    expect(withLivePercents(input, {})).toBe(input);
  });
});

describe("recentLines", () => {
  test("skips progress noise and returns the last n lines in order", () => {
    const events = [asset("a.jpg", "copied"), progress(1, 9), asset("b.jpg", "skipped"), progress(2, 9), asset("c.jpg", "failed")];
    expect(recentLines(events, 2)).toEqual(["b.jpg: skipped", "c.jpg: failed"]);
    expect(recentLines(events)).toEqual(["a.jpg: copied", "b.jpg: skipped", "c.jpg: failed"]);
  });

  test("messages of other events are shown as text", () => {
    expect(recentLines([ev("info", null, "step 1 started")])).toEqual(["step 1 started"]);
  });

  test("nothing to show", () => {
    expect(recentLines([])).toEqual([]);
    expect(recentLines([progress(1, 2)])).toEqual([]);
  });
});

describe("countsText", () => {
  test("known outcomes in a fixed order, zeros omitted", () => {
    expect(countsText({ failed: 2, copied: 34, skipped: 132, "in-target-trash": 0 })).toBe("34 copied · 132 skipped · 2 failed");
  });
  test("unknown outcomes follow alphabetically", () => {
    expect(countsText({ zeta: 1, copied: 2, alpha: 3 })).toBe("2 copied · 3 alpha · 1 zeta");
  });
  test("nothing yet", () => {
    expect(countsText({})).toBe("No assets processed yet");
  });
});
