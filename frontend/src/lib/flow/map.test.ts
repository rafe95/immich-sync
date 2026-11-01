import { afterEach, expect, test } from "bun:test";
import type { Instance } from "../api.ts";
import type { JobRecord, ScheduleRecord, StepRecord } from "../jobs.ts";
import type { Run } from "../runs.ts";
import { ADD_INSTANCE_NODE_ID, addInstanceNode, autoLayout, buildMap, COLUMN_GAP, formatWhen, loadLayout, mergeLayout, ROW_GAP, saveLayout, type MapInput } from "./map.ts";

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

test("autoLayout puts the placeholder in the first column under the other loners and sources", () => {
  const { nodes, edges } = buildMap(input({ instances: [inst("a"), inst("b"), inst("c")], jobs: [job([step("a", "b")])] }));
  const pos = autoLayout([...nodes, addInstanceNode()], edges);
  // a is a source (column 0, row 0), b a target (column 2), c has no job (loner, row 1), the placeholder follows c.
  expect(pos["a"]).toEqual({ x: 0, y: 0 });
  expect(pos["b"]).toEqual({ x: 2 * COLUMN_GAP, y: 0 });
  expect(pos["c"]).toEqual({ x: 0, y: ROW_GAP });
  expect(pos[ADD_INSTANCE_NODE_ID]).toEqual({ x: 0, y: 2 * ROW_GAP });
});

test("with no instances the placeholder is alone at the origin", () => {
  expect(autoLayout([addInstanceNode()], [])[ADD_INSTANCE_NODE_ID]).toEqual({ x: 0, y: 0 });
});
