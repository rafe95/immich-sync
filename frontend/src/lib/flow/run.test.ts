import { describe, expect, test } from "bun:test";
import { buildRunGraph, phaseSegments, preflightState, stepLive, stepPercents, stepProgressLabel, stepVisual, triggerLabel, type RunStepNodeData } from "./run.ts";
import { formatDuration, initialConsole, reduceEvents, type ConsoleState, type Run, type RunEvent } from "../runs.ts";

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

const log = (data: unknown): RunEvent => ({ id: nextId++, runId: "r1", ts: "t", level: "info", type: "log", message: "m", data });
const summaryEv = (step: number, sum: Record<string, unknown>): RunEvent => ({ id: nextId++, runId: "r1", ts: "t", level: "info", type: "summary", message: null, data: { step, status: "completed", summary: sum } });
const stepData = (g: ReturnType<typeof buildRunGraph>, pos: number) => g.nodes.find((n) => n.id === `step-${pos}`)!.data as unknown as RunStepNodeData;

describe("formatDuration", () => {
  test("seconds, minutes, hours", () => {
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(12 * 60_000)).toBe("12 min");
    expect(formatDuration(65 * 60_000)).toBe("1 h 5 min");
    expect(formatDuration(120 * 60_000)).toBe("2 h");
    expect(formatDuration(-1)).toBe("-");
  });
});

describe("stepLive and phaseSegments", () => {
  const r = run("running", ["running"]);
  test("no phase reported gives no segmented bar", () => {
    expect(phaseSegments("copy", stepLive(state(progress({ done: 1, total: 4 })), r)[1])).toBeNull();
    expect(phaseSegments("copy", undefined)).toBeNull();
  });
  test("running phase means planning", () => {
    const segs = phaseSegments("copy", stepLive(state(log({ step: 1, phase: "running" })), r)[1])!;
    expect(segs.map((x) => x.state)).toEqual(["active", "todo", "todo", "todo"]);
  });
  test("copying progress marks plan done and upload active", () => {
    const segs = phaseSegments("move", stepLive(state(log({ step: 1, phase: "running" }), progress({ step: 1, phase: "copying", done: 2, total: 4 })), r)[1])!;
    expect(segs.map((x) => `${x.label}:${x.state}`)).toEqual(["Plan:done", "Upload + verify:active", "Metadata:todo", "Finalize:todo"]);
  });
  test("metadata-wait and finalizing advance the bar", () => {
    expect(phaseSegments("copy", stepLive(state(log({ step: 1, phase: "metadata-wait" })), r)[1])!.map((x) => x.state)).toEqual(["done", "done", "active", "todo"]);
    expect(phaseSegments("move", stepLive(state(progress({ step: 1, phase: "finalizing", done: 1, total: 2 })), r)[1])!.map((x) => x.state)).toEqual(["done", "done", "done", "active"]);
  });
  test("a metadata sync step only has plan and metadata", () => {
    const segs = phaseSegments("sync_metadata", stepLive(state(progress({ step: 1, phase: "metadata", done: 1, total: 2 })), r)[1])!;
    expect(segs.map((x) => x.label)).toEqual(["Plan", "Metadata"]);
    expect(segs.map((x) => x.state)).toEqual(["done", "active"]);
  });
});

describe("header labels", () => {
  test("stepProgressLabel only while running", () => {
    expect(stepProgressLabel(run("running", ["completed", "running", "pending"]))).toBe("step 2 of 3");
    expect(stepProgressLabel(run("completed", ["completed"]))).toBeNull();
    expect(stepProgressLabel(run("running", ["pending"]))).toBeNull();
  });
  test("triggerLabel", () => {
    expect(triggerLabel("manual")).toBe("Manual");
    expect(triggerLabel("schedule")).toBe("Scheduled");
    expect(triggerLabel("api")).toBe("Api");
  });
});

describe("buildRunGraph node data", () => {
  test("a finished step shows duration and counts from its summary", () => {
    const r = run("running", ["completed", "pending"]);
    r.steps[0]!.startedAt = "2026-01-01T00:00:00Z";
    r.steps[0]!.finishedAt = "2026-01-01T00:12:00Z";
    const g = buildRunGraph(r, state(summaryEv(1, { assetsFound: 10, copied: 7, skipped: 2, failed: 1 })));
    const d = stepData(g, 1);
    expect(d.right).toBe("12 min");
    expect(d.lines).toEqual(["7 copied · 2 skipped", "1 failed"]);
    expect(stepData(g, 2).lines).toEqual(["Waiting for step 1"]);
  });
  test("falls back to the stored step summary", () => {
    const r = run("completed", ["completed"]);
    r.steps[0]!.summary = { assetsFound: 3, moved: 3 };
    expect(stepData(buildRunGraph(r, state()), 1).lines).toEqual(["3 moved"]);
  });
  test("a running step shows live counts, percent and phases", () => {
    const r = run("running", ["running"]);
    const g = buildRunGraph(r, state(progress({ step: 1, phase: "copying", done: 5, total: 10 })));
    const d = stepData(g, 1);
    expect(d.right).toBe("50%");
    expect(d.percent).toBe(50);
    expect(d.lines).toEqual(["5 / 10 assets"]);
    expect(d.phases?.[1]?.state).toBe("active");
  });
  test("preflight reports instance count only from known settings", () => {
    const g = buildRunGraph(run("running", ["running"]), state());
    expect(g.nodes[0]!.data).toEqual({ state: "passed", instances: 2, locksTaken: true });
    const dry = run("running", ["running"]);
    dry.dryRun = true;
    expect((buildRunGraph(dry, state()).nodes[0]!.data as { locksTaken: boolean }).locksTaken).toBe(false);
  });
});
