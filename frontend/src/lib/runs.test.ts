import { describe, expect, test } from "bun:test";
import {
  buildRunBody, defaultForm, eventsUrl, formFromRun, initialConsole, logAsText, MAX_LINES, MAX_FAILURES, formatBytes, lineVisible, stepSummaries, progressPercent, reconnectDelay, reduceEvent, reduceEvents, validateForm,
  statusClass, RUN_STATUSES, isTerminal,
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

test("body builder: includeTrashed is sent only when ticked and never for a move", () => {
  const base = { ...defaultForm(), sourceId: A, targetId: B };
  const options = (f: typeof base) => {
    const r = buildRunBody(f);
    if (!r.ok) throw new Error("expected ok");
    return (r.body.steps as any[])[0].options;
  };
  expect(options(base)).not.toHaveProperty("includeTrashed");
  expect(options({ ...base, includeTrashed: true }).includeTrashed).toBe(true);
  expect(options({ ...base, includeTrashed: true, operation: "move" })).not.toHaveProperty("includeTrashed");
});

test("formFromRun keeps includeTrashed from the stored run", () => {
  const run = { settings: { steps: [{ operation: "copy", source: { id: A }, target: { id: B }, options: { range: null, kind: "all", metadata: true, includeTrashed: true, dryRun: true } }] } } as any;
  expect(formFromRun(run)?.includeTrashed).toBe(true);
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
  expect(formFromRun(run)).toEqual({ operation: "move", sourceId: A, targetId: B, rangeMode: "window", from: "2024-01-01", to: "2024-02-01", kind: "photos", metadata: false, includeTrashed: false, dryRun: false });
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

describe("end-of-run summary", () => {
  const ev = (id: number, type: string, level: "info" | "error" | "warning", data: unknown, message: string | null = null): RunEvent => ({ id, runId: "r", ts: "2026-01-01T00:00:00Z", level, type, message, data });
  const failed = (id: number, step: number, name: string, message: string) => ev(id, "asset", "error", { step, asset: { fileName: name, outcome: "failed", message } });

  test("collects failed assets per step, capped", () => {
    let s = reduceEvents(initialConsole(), [failed(1, 1, "a.jpg", "boom"), ev(2, "asset", "info", { step: 1, asset: { fileName: "b.jpg", outcome: "copied" } })]);
    expect(s.failures).toEqual([{ eventId: 1, step: 1, name: "a.jpg", message: "boom" }]);
    for (let i = 0; i < MAX_FAILURES + 2; i++) s = reduceEvent(s, failed(10 + i, 1, "x", "m"));
    expect(s.failures.length).toBe(MAX_FAILURES);
    expect(s.failuresDropped).toBe(3);
  });

  test("builds a block per step with failures", () => {
    const sum = ev(5, "summary", "warning", { step: 1, status: "completed_with_failures", summary: { assetsFound: 10, copied: 5, moved: 0, synced: 0, unchanged: 0, skipped: 2, inTargetTrash: 1, failed: 2, cancelled: 0, wouldCopy: 0, wouldMove: 0, wouldSync: 0, bytesCopied: 2048, bytesToTransfer: 0, dryRun: false } }, "Step 1 completed with failures");
    const s = reduceEvents(initialConsole(), [failed(1, 1, "a.jpg", "boom"), failed(2, 2, "other", "x"), sum]);
    const [v] = stepSummaries(s.summaries, s.failures);
    expect(v?.totals).toMatchObject({ found: 10, done: 5, doneLabel: "copied", skipped: 2, inTargetTrash: 1, failed: 2, bytes: 2048, dryRun: false });
    expect(v?.failures.map((f) => f.name)).toEqual(["a.jpg"]);
  });

  test("dry run uses would* counts; error step has no totals; ignores non-step summaries", () => {
    const dry = ev(1, "summary", "info", { step: 1, status: "completed", summary: { assetsFound: 4, wouldMove: 3, bytesToTransfer: 100, dryRun: true } });
    const err = ev(2, "summary", "error", { step: 2, status: "error", summary: { message: "no" } }, "Step 2 error: no");
    const job = ev(3, "summary", "info", { status: "completed" });
    const out = stepSummaries([dry, err, job]);
    expect(out.length).toBe(2);
    expect(out[0]?.totals).toMatchObject({ done: 3, doneLabel: "moved", bytes: 100, dryRun: true });
    expect(out[1]?.totals).toBeNull();
    expect(out[1]?.message).toContain("no");
  });

  test("formatBytes and failures-only line filter", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.50 KB");
    const f = { minRank: 1, rank: 1, showAssets: true, failuresOnly: true };
    expect(lineVisible(failed(1, 1, "a", "m"), f)).toBe(true);
    expect(lineVisible(ev(2, "asset", "warning", { step: 1, asset: { outcome: "in-target-trash" } }), f)).toBe(false);
    expect(lineVisible(ev(3, "asset", "info", { step: 1, asset: { outcome: "skipped" } }), f)).toBe(false);
    expect(lineVisible(ev(4, "log", "warning", {}, "w"), f)).toBe(true);
    expect(lineVisible(ev(5, "log", "info", {}, "i"), { ...f, failuresOnly: false })).toBe(true);
  });

  test("progress ticks are log lines only at the debug level", () => {
    const tick = ev(6, "progress", "info", { step: 1, done: 1, total: 5 }, "");
    const all = { minRank: 1, rank: 1, showAssets: true, failuresOnly: false };
    expect(lineVisible(tick, all)).toBe(false);
    expect(lineVisible(tick, { ...all, minRank: 0 })).toBe(true);
  });
});

test("a skipped schedule firing is terminal, filterable and has a neutral badge", () => {
  expect(isTerminal("skipped")).toBe(true);
  expect(RUN_STATUSES).toContain("skipped");
  expect(statusClass("skipped")).toBe("preset-tonal-surface");
  expect(statusClass("failed")).toBe("preset-tonal-error");
  expect(statusClass("completed")).toBe("preset-tonal-success");
});

test("a stream split at any point (reconnect resuming from lastId, with replayed overlap) equals the unsplit stream", () => {
  const all = Array.from({ length: 12 }, (_, i) =>
    i % 3 === 0 ? ev(i + 1, { type: "asset", data: { step: 1, asset: { fileName: `f${i}`, outcome: i % 2 ? "failed" : "copied" } } }) : ev(i + 1, { type: "progress", data: { done: i, total: 12 } }),
  );
  const whole = reduceEvents(initialConsole(), all);
  for (let cut = 0; cut <= all.length; cut++) {
    const first = reduceEvents(initialConsole(), all.slice(0, cut));
    const resumed = reduceEvents(first, all.slice(Math.max(0, cut - 2))); // server replays a little overlap
    expect(resumed).toEqual(whole);
  }
});
