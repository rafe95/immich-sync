import { expect, test } from "bun:test";
import {
  buildRunBody, defaultForm, eventsUrl, formFromRun, initialConsole, logAsText, MAX_LINES, progressPercent, reconnectDelay, reduceEvent, reduceEvents, validateForm,
  type Run, type RunEvent,
} from "./runs.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ev = (id: number, over: Partial<RunEvent> = {}): RunEvent => ({ id, runId: "r", ts: "2026-01-01T00:00:00Z", level: "info", type: "log", message: `m${id}`, data: null, ...over });

test("form validation: same instance, a window needs from or to (either one is enough)", () => {
  expect(validateForm({ ...defaultForm(), sourceId: A, targetId: A })).toContain("Source and target must be different instances.");
  const f = { ...defaultForm(), sourceId: A, targetId: B, rangeMode: "window" as const, from: "2024-01-01" };
  expect(validateForm(f)).toEqual([]);
  expect(validateForm({ ...f, from: "" }).join()).toContain("from date, a to date, or both");
  expect(validateForm({ ...f, from: "", to: "2024-02-01" })).toEqual([]);
  expect(validateForm({ ...f, to: "2023-01-01" }).join()).toContain("must not be after");
  expect(validateForm({ ...f, to: "2024-02-01" })).toEqual([]);
});

test("body builder: a from-only window sends no to", () => {
  const r = buildRunBody({ ...defaultForm(), sourceId: A, targetId: B, rangeMode: "window", from: "2024-01-01" });
  if (!r.ok) throw new Error("expected ok");
  expect((r.body.steps as any[])[0].options.range).toEqual({ from: "2024-01-01" });
});

test("body builder: window, sync_metadata forces metadata, dry run override", () => {
  const f = { ...defaultForm(), sourceId: A, targetId: B, rangeMode: "window" as const, to: "2024-02-01", operation: "sync_metadata" as const, metadata: false };
  const r = buildRunBody(f, { source: "a", target: "b" });
  if (!r.ok) throw new Error("expected ok");
  expect(r.body).toEqual({
    name: "Sync metadata a to b",
    dryRun: true,
    steps: [{ operation: "sync_metadata", sourceId: A, targetId: B, options: { range: { to: "2024-02-01" }, kind: "all", metadata: true, dryRun: true } }],
  });
  const real = buildRunBody({ ...defaultForm(), sourceId: A, targetId: B }, {}, false);
  if (!real.ok) throw new Error("expected ok");
  expect((real.body.steps as any[])[0].options.range).toBeNull();
  expect(real.body.dryRun).toBe(false);
  expect(buildRunBody(defaultForm()).ok).toBe(false);
});

test("formFromRun restores settings with dryRun off", () => {
  const run = { settings: { steps: [{ operation: "move", source: { id: A }, target: { id: B }, options: { range: { from: "2024-01-01", to: "2024-02-01" }, kind: "photos", metadata: false, dryRun: true } }] } } as unknown as Run;
  expect(formFromRun(run)).toEqual({ operation: "move", sourceId: A, targetId: B, rangeMode: "window", from: "2024-01-01", to: "2024-02-01", kind: "photos", metadata: false, dryRun: false });
});

test("reducer: cursor, dedupe on replay, progress, counts", () => {
  let s = reduceEvents(initialConsole(), [ev(1), ev(2, { type: "progress", data: { processed: 5, total: 20 } }), ev(3, { type: "asset", data: { id: "x", fileName: "a.jpg", outcome: "copied" } })]);
  expect(s.lastId).toBe(3);
  expect(progressPercent(s.progress)).toBe(25);
  expect(s.counts).toEqual({ copied: 1 });
  const again = reduceEvents(s, [ev(2), ev(3), ev(4)]); // reconnect replay
  expect(again.events.map((e) => e.id)).toEqual([1, 2, 3, 4]);
  expect(eventsUrl("r", again.lastId)).toBe("/api/runs/r/events?after=4");
  expect(eventsUrl("r", 0)).toBe("/api/runs/r/events");
  expect(reduceEvent(s, ev(3))).toBe(s);
});

test("reducer caps lines and counts dropped", () => {
  const all = Array.from({ length: MAX_LINES + 10 }, (_, i) => ev(i + 1));
  const s = reduceEvents(initialConsole(), all);
  expect(s.events.length).toBe(MAX_LINES);
  expect(s.dropped).toBe(10);
  expect(s.events[0]!.id).toBe(11);
});

test("reconnect delay backs off and caps", () => {
  expect([0, 1, 2, 10].map(reconnectDelay)).toEqual([1000, 2000, 4000, 15000]);
});

test("text export", () => {
  expect(logAsText([ev(1, { level: "warning" })])).toBe("2026-01-01T00:00:00Z WARNING m1\n");
});
