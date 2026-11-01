import { afterEach, expect, test } from "bun:test";
import type { Instance } from "../api.ts";
import type { JobRecord, ScheduleRecord, StepRecord } from "../jobs.ts";
import type { Run } from "../runs.ts";
import { ADD_INSTANCE_NODE_ID, addInstanceNode, autoLayout, buildMap, COLUMN_GAP, formatWhen, loadLayout, mergeLayout, placeholderPosition, ROW_GAP, saveLayout, type MapInput } from "./map.ts";

const inst = (id: string, over: Partial<Instance> = {}): Instance => ({
  id, alias: id, apiUrl: `http://${id}/api`, note: null, isDefault: false, lastCheck: null, lastCheckedAt: null, createdAt: "", updatedAt: "", ...over,
});
const step = (sourceId: string, targetId: string, over: Partial<StepRecord> = {}): StepRecord => ({
  operation: "copy", sourceId, targetId, options: {}, onFailure: "continue", onError: "stop", ...over,
});
const sched = (over: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  id: "s", jobId: "j", cron: "0 3 * * *", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: null, nextRuns: ["2026-11-01T03:00:00.000Z"], ...over,
});
const job = (steps: StepRecord[], schedule: ScheduleRecord | null = null, over: Partial<JobRecord> = {}): JobRecord => ({
  id: "j", name: "Nightly", hasMove: steps.some((s) => s.operation === "move"), steps, schedule, createdAt: "", updatedAt: "", ...over,
});
const run = (over: Partial<Run> = {}): Run => ({
  id: "r1", jobName: "Nightly", trigger: "manual", dryRun: false, status: "running",
  settings: { jobId: "j", name: "Nightly", dryRun: false, steps: [] }, summary: null, createdAt: "", startedAt: null, finishedAt: null,
  steps: [{ position: 1, status: "running", summary: null, startedAt: null, finishedAt: null }], ...over,
});
const input = (over: Partial<MapInput> = {}): MapInput => ({ instances: [inst("a"), inst("b")], jobs: [], lastResults: {}, active: [], ...over });

test("one edge per step with job:position ids and jobId data", () => {
  const { nodes, edges } = buildMap(input({ jobs: [job([step("a", "b"), step("b", "a")])] }));
  expect(nodes.map((n) => n.id)).toEqual(["a", "b"]);
  expect(edges.map((e) => e.id)).toEqual(["j:1", "j:2"]);
  expect(edges[0]).toMatchObject({ source: "a", target: "b", data: { jobId: "j" } });
});

test("label and style rules", () => {
  const label = (j: JobRecord, extra: Partial<MapInput> = {}) => {
    const e = buildMap(input({ jobs: [j], ...extra })).edges[0];
    return [e.data!.label, e.data!.style];
  };
  const when = formatWhen("2026-11-01T03:00:00.000Z");
  expect(label(job([step("a", "b")]))).toEqual(["Nightly · not scheduled", "muted"]);
  expect(label(job([step("a", "b")], sched()))).toEqual([`Nightly · ${when}`, "solid"]);
  expect(label(job([step("a", "b")], sched({ enabled: false })))).toEqual(["Nightly · paused", "muted"]);
  expect(label(job([step("a", "b", { operation: "move" })], sched()))).toEqual(["Nightly · move not confirmed", "warning"]);
  expect(label(job([step("a", "b")], sched()), { active: [{ run: run(), percent: 42, queued: false }] })).toEqual(["Nightly · 42%", "running"]);
  expect(label(job([step("a", "b")], sched()), { active: [{ run: run({ status: "queued", steps: [{ position: 1, status: "pending", summary: null, startedAt: null, finishedAt: null }] }), percent: null, queued: true }] })).toEqual([
    "Nightly · waiting for lock",
    "muted",
  ]);
  expect(label(job([step("a", "b")]), { lastResults: { j: { status: "completed", finishedAt: "2026-10-30T10:00:00.000Z" } } })[0]).toBe(
    "Nightly · not scheduled · last: completed",
  );
});

test("tones follow the operation", () => {
  const { edges } = buildMap(input({ jobs: [job([step("a", "b", { operation: "move" }), step("a", "b", { operation: "sync_metadata" }), step("a", "b")])] }));
  expect(edges.map((e) => e.data!.tone)).toEqual(["warning", "tertiary", "primary"]);
});

test("activity badges for running and queued runs", () => {
  const j = job([step("a", "b")]);
  const running = buildMap(input({ jobs: [j], active: [{ run: run(), percent: 10, queued: false }] }));
  expect(running.nodes.find((n) => n.id === "b")!.data.activity).toEqual({ kind: "lock", job: "Nightly" });
  expect(running.nodes.find((n) => n.id === "a")!.data.activity).toEqual({ kind: "reading", job: "Nightly" });
  const queued = buildMap(input({ jobs: [j], active: [{ run: run({ status: "queued", steps: [] }), percent: null, queued: true }] }));
  expect(queued.nodes.find((n) => n.id === "a")!.data.activity).toEqual({ kind: "waiting", job: "Nightly" });
  expect(queued.nodes.find((n) => n.id === "b")!.data.activity).toEqual({ kind: "waiting", job: "Nightly" });
});

test("a step pointing at an unknown instance gets a placeholder node", () => {
  const { nodes, edges } = buildMap(input({ jobs: [job([step("a", "gone")])] }));
  const ghost = nodes.find((n) => n.id === "unknown:gone")!;
  expect(ghost.data.alias).toBe("Unknown instance");
  expect(ghost.data.health.tone).toBe("error");
  expect(edges[0].target).toBe("unknown:gone");
});

test("autoLayout puts sources, middles, targets and loners in columns", () => {
  const i = input({ instances: [inst("a"), inst("b"), inst("c"), inst("d")], jobs: [job([step("a", "b"), step("b", "c")])] });
  const { nodes, edges } = buildMap(i);
  const pos = autoLayout(nodes, edges);
  expect(pos.a.x).toBe(0);
  expect(pos.b.x).toBe(320);
  expect(pos.c.x).toBe(640);
  expect(pos.d.x).toBe(0);
  expect(pos.d.y).toBeGreaterThan(pos.a.y);
});

test("mergeLayout keeps saved positions, drops stale ids, keeps new auto positions", () => {
  const auto = { a: { x: 0, y: 0 }, b: { x: 320, y: 0 } };
  expect(mergeLayout(auto, { a: { x: 5, y: 6 }, old: { x: 1, y: 1 } })).toEqual({ a: { x: 5, y: 6 }, b: { x: 320, y: 0 } });
  expect(mergeLayout(auto, null)).toEqual(auto);
});

const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (realStorage) Object.defineProperty(globalThis, "localStorage", realStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

test("layout storage never throws", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("denied");
    },
  });
  expect(loadLayout()).toBeNull();
  expect(() => saveLayout({ a: { x: 1, y: 2 } })).not.toThrow();
});

test("layout round-trips through storage and ignores junk", () => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  saveLayout({ a: { x: 1, y: 2 } });
  expect(loadLayout()).toEqual({ a: { x: 1, y: 2 } });
  store.set("immich-sync.map-layout.v1", "not json");
  expect(loadLayout()).toBeNull();
});

test("the add-instance placeholder is a fixed 'add' node", () => {
  const n = addInstanceNode();
  expect(n).toMatchObject({ id: ADD_INSTANCE_NODE_ID, type: "add", draggable: false });
  expect(buildMap(input()).nodes.map((x) => x.id)).not.toContain(ADD_INSTANCE_NODE_ID);
});

test("the placeholder goes below the lowest node, at the left-most x, so it never overlaps a moved node", () => {
  expect(placeholderPosition([])).toEqual({ x: 0, y: 0 });
  expect(placeholderPosition([{ x: 300, y: 40 }, { x: 120, y: 500 }, { x: 640, y: 200 }])).toEqual({ x: 120, y: 500 + ROW_GAP });
});

test("edges between the same pair of instances get separate lanes, across steps and jobs", () => {
  const { edges } = buildMap(input({
    instances: [inst("a"), inst("b"), inst("c")],
    jobs: [job([step("a", "b"), step("a", "b"), step("a", "c")], null, { id: "j1" }), job([step("a", "b")], null, { id: "j2" })],
  }));
  expect(edges.map((e) => [e.id, e.data!.lane])).toEqual([["j1:1", 0], ["j1:2", 1], ["j1:3", 0], ["j2:1", 2]]);
});

test("a live step overrides the run record's running step, so the percentage lands on the right line", () => {
  const j = job([step("a", "b"), step("a", "b")]);
  const twoSteps = run({ steps: [
    { position: 1, status: "running", summary: null, startedAt: null, finishedAt: null },
    { position: 2, status: "pending", summary: null, startedAt: null, finishedAt: null },
  ] });
  const labels = (stepOverride?: number | null) =>
    buildMap(input({ jobs: [j], active: [{ run: twoSteps, percent: 63, queued: false, step: stepOverride }] })).edges.map((e) => e.data!.label);
  expect(labels()).toEqual(["Nightly · 63%", "Nightly · not scheduled"]);
  expect(labels(2)).toEqual(["Nightly · not scheduled", "Nightly · 63%"]);
  // a run record fetched during preflight (no step running yet) still shows the percentage on the live step
  const preflight = run({ steps: twoSteps.steps.map((s) => ({ ...s, status: "pending" })) });
  expect(buildMap(input({ jobs: [j], active: [{ run: preflight, percent: 20, queued: false, step: 1 }] })).edges.map((e) => e.data!.label)).toEqual(["Nightly · 20%", "Nightly · not scheduled"]);
});

test("a running ad-hoc run draws a temporary line with its percentage and marks the nodes", () => {
  const adhoc = run({
    id: "r9", jobName: "Copy a to b", settings: { name: "Copy a to b", dryRun: true, steps: [{ position: 1, operation: "copy", source: { id: "a", alias: "a" }, target: { id: "b", alias: "b" }, options: { range: null, kind: "all", metadata: true, dryRun: true } }] },
  });
  const { nodes, edges } = buildMap(input({ active: [{ run: adhoc, percent: 40, queued: false }] }));
  expect(edges).toHaveLength(1);
  expect(edges[0]).toMatchObject({ id: "run:r9:1", source: "a", target: "b", data: { label: "Copy a to b · 40%", style: "running", runId: "r9" } });
  expect(nodes.find((n) => n.id === "b")!.data.activity).toMatchObject({ kind: "lock" });
  expect(nodes.find((n) => n.id === "a")!.data.activity).toMatchObject({ kind: "reading" });
});
