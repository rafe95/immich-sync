import { describe, expect, test } from "bun:test";
import { buildRunGraph, preflightState, stepPercents, stepVisual } from "./run.ts";
import { initialConsole, reduceEvents, type ConsoleState, type Run, type RunEvent } from "../runs.ts";

const stepSettings = (position: number) => ({
  position,
  operation: "copy" as const,
  source: { id: "a", alias: "Home" },
  target: { id: "b", alias: "Backup" },
  options: { range: null, kind: "all" as const, metadata: true, dryRun: false },
});
const run = (status: Run["status"], stepStatuses: string[]): Run => ({
  id: "r1",
  jobName: "j",
  trigger: "manual",
  dryRun: false,
  status,
  settings: { name: "j", dryRun: false, steps: stepStatuses.map((_, i) => stepSettings(i + 1)) },
  summary: null,
  createdAt: "2026-01-01T00:00:00Z",
  startedAt: null,
  finishedAt: null,
  steps: stepStatuses.map((s, i) => ({ position: i + 1, status: s, summary: null, startedAt: null, finishedAt: null })),
});
let nextId = 1;
const progress = (data: unknown): RunEvent => ({ id: nextId++, runId: "r1", ts: "t", level: "info", type: "progress", message: null, data });
const state = (...evs: RunEvent[]): ConsoleState => reduceEvents(initialConsole(), evs);

describe("stepVisual", () => {
  test("maps every backend status", () => {
    expect(stepVisual("pending")).toBe("waiting");
    expect(stepVisual("running")).toBe("running");
    expect(stepVisual("completed")).toBe("done");
    expect(stepVisual("completed_with_failures")).toBe("done_with_failures");
    expect(stepVisual("error")).toBe("failed");
    expect(stepVisual("cancelled")).toBe("cancelled");
    expect(stepVisual("not_run")).toBe("not_run");
    expect(stepVisual("something_else")).toBe("waiting");
  });
});

describe("preflightState", () => {
  test("queued waits for the lock", () => expect(preflightState(run("queued", ["pending"]))).toBe("waiting_for_lock"));
  test("a started step means it passed", () => expect(preflightState(run("running", ["running", "pending"]))).toBe("passed"));
  test("terminal with all steps pending failed", () => expect(preflightState(run("failed", ["pending", "pending"]))).toBe("failed"));
  test("running with nothing started is checking", () => expect(preflightState(run("running", ["pending"]))).toBe("checking"));
});

describe("stepPercents", () => {
  test("progress with data.step goes to that step", () => {
    const r = run("running", ["completed", "running"]);
    expect(stepPercents(state(progress({ step: 1, done: 5, total: 10 })), r)).toEqual({ 1: 50 });
  });
  test("progress without data.step goes to the running step", () => {
    const r = run("running", ["completed", "running"]);
    expect(stepPercents(state(progress({ done: 1, total: 4 })), r)).toEqual({ 2: 25 });
  });
  test("progress without data.step and no running step is dropped", () => {
    expect(stepPercents(state(progress({ done: 1, total: 4 })), run("queued", ["pending"]))).toEqual({});
  });
  test("unknown total gives null", () => {
    expect(stepPercents(state(progress({ step: 1, done: 3 })), run("running", ["running"]))).toEqual({ 1: null });
  });
});

describe("buildRunGraph", () => {
  test("preflight plus one node per step, edge styles follow progress", () => {
    const r = run("running", ["completed", "running", "pending"]);
    const g = buildRunGraph(r, state());
    expect(g.nodes.length).toBe(4);
    expect(g.nodes.map((n) => n.id)).toEqual(["preflight", "step-1", "step-2", "step-3"]);
    expect(g.nodes[1]!.position.x).toBe(400);
    expect(g.nodes[2]!.position.x).toBe(760);
    expect(g.edges.map((e) => (e.data as { style: string }).style)).toEqual(["solid", "running", "muted"]);
  });
  test("a run with no steps has only the preflight node", () => {
    const g = buildRunGraph(run("queued", []), state());
    expect(g.nodes.length).toBe(1);
    expect(g.edges.length).toBe(0);
  });
});
