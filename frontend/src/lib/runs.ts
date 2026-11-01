/** Pure run-screen logic: request body builder, event reducer, SSE resume cursor, log export. No DOM access. */

export type Operation = "copy" | "move" | "sync_metadata";
export type Kind = "all" | "photos" | "videos";
export type RunStatus = "queued" | "running" | "completed" | "completed_with_failures" | "failed" | "cancelled" | "interrupted" | "skipped";
export type EventLevel = "debug" | "info" | "warning" | "error";

export const RUN_STATUSES: RunStatus[] = ["queued", "running", "completed", "completed_with_failures", "failed", "cancelled", "interrupted", "skipped"];
const TERMINAL = new Set<RunStatus>(["completed", "completed_with_failures", "failed", "cancelled", "interrupted", "skipped"]);
export const isTerminal = (s: RunStatus) => TERMINAL.has(s);
export const statusLabel = (s: string) => s.replaceAll("_", " ");

/** Skeleton badge preset for a run status; `skipped` (a schedule firing that did not start) is neutral. */
export const statusClass = (s: RunStatus): string =>
  s === "completed" ? "preset-tonal-success"
    : s === "failed" || s === "interrupted" ? "preset-tonal-error"
      : s === "completed_with_failures" || s === "cancelled" ? "preset-tonal-warning"
        : s === "skipped" ? "preset-tonal-surface"
          : "preset-tonal-primary";

export type RunEvent = { id: number; runId: string; ts: string; level: EventLevel; type: string; message: string | null; data: unknown };

export type RunStepSettings = {
  position: number;
  operation: Operation;
  source: { id: string; alias: string };
  target: { id: string; alias: string };
  options: { range: { from?: string; to?: string } | { lastDays: number } | null; kind: Kind; metadata: boolean; includeTrashed?: boolean; dryRun: boolean };
};
export type Run = {
  id: string;
  jobName: string;
  trigger: string;
  dryRun: boolean;
  status: RunStatus;
  settings: { jobId?: string | null; name: string; dryRun: boolean; steps: RunStepSettings[] };
  summary: unknown;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: Array<{ position: number; status: string; summary: unknown; startedAt: string | null; finishedAt: string | null }>;
};

// ---- request body ----

export type RunForm = {
  operation: Operation;
  sourceId: string;
  targetId: string;
  rangeMode: "all" | "window";
  from: string;
  to: string;
  kind: Kind;
  metadata: boolean;
  /** Also consider assets in the source's trash (copy and sync metadata only). */
  includeTrashed: boolean;
  dryRun: boolean;
};

export const defaultForm = (): RunForm => ({
  operation: "copy",
  sourceId: "",
  targetId: "",
  rangeMode: "all",
  from: "",
  to: "",
  kind: "all",
  metadata: true,
  includeTrashed: false,
  dryRun: true,
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateForm(f: RunForm): string[] {
  const p: string[] = [];
  if (!f.sourceId) p.push("Choose a source instance.");
  if (!f.targetId) p.push("Choose a target instance.");
  if (f.sourceId && f.sourceId === f.targetId) p.push("Source and target must be different instances.");
  if (f.rangeMode === "window") {
    if (!f.from && !f.to) p.push("Set a from date, a to date, or both (or choose all assets).");
    if (f.from && !DATE.test(f.from)) p.push("The from date is not a valid date.");
    if (f.to && !DATE.test(f.to)) p.push("The to date is not a valid date.");
    if (f.from && f.to && DATE.test(f.from) && DATE.test(f.to) && f.from > f.to) p.push("The from date must not be after the to date.");
  }
  return p;
}

const OP_LABEL: Record<Operation, string> = { copy: "Copy", move: "Move", sync_metadata: "Sync metadata" };
export const operationLabel = (o: Operation) => OP_LABEL[o];

/** Body for POST /api/runs. `overrideDryRun` is used by "Run for real". Returns problems instead of throwing. */
export function buildRunBody(
  f: RunForm,
  aliases: { source?: string; target?: string } = {},
  overrideDryRun?: boolean,
): { ok: true; body: Record<string, unknown> } | { ok: false; problems: string[] } {
  const problems = validateForm(f);
  if (problems.length) return { ok: false, problems };
  const range = f.rangeMode === "window" ? { ...(f.from ? { from: f.from } : {}), ...(f.to ? { to: f.to } : {}) } : null;
  const dryRun = overrideDryRun ?? f.dryRun;
  return {
    ok: true,
    body: {
      name: `${OP_LABEL[f.operation]}${aliases.source && aliases.target ? ` ${aliases.source} to ${aliases.target}` : ""}`.slice(0, 100),
      dryRun,
      steps: [
        {
          operation: f.operation,
          sourceId: f.sourceId,
          targetId: f.targetId,
          options: {
            range,
            kind: f.kind,
            metadata: f.operation === "sync_metadata" ? true : f.metadata,
            // Never sent for a move: it would trash assets that are already in the trash.
            ...(f.includeTrashed && f.operation !== "move" ? { includeTrashed: true } : {}),
            dryRun,
          },
        },
      ],
    },
  };
}

/** Rebuilds the form from a stored run (first step), e.g. for "Run for real". Returns null if not representable. */
export function formFromRun(run: Run): RunForm | null {
  const s = run.settings.steps[0];
  if (!s || run.settings.steps.length !== 1) return null;
  const r = s.options.range;
  if (r && "lastDays" in r) return null;
  return {
    operation: s.operation,
    sourceId: s.source.id,
    targetId: s.target.id,
    rangeMode: r ? "window" : "all",
    from: r && "from" in r ? (r.from ?? "") : "",
    to: r && "to" in r ? (r.to ?? "") : "",
    kind: s.options.kind,
    metadata: s.options.metadata,
    includeTrashed: s.options.includeTrashed === true,
    dryRun: false,
  };
}

// ---- SSE ----

/** URL to (re)connect to: always resumes after the last event seen. */
export const eventsUrl = (runId: string, lastId: number) => `/api/runs/${runId}/events${lastId > 0 ? `?after=${lastId}` : ""}`;

/** Reconnect backoff in ms: 1s, 2s, 4s ... capped at 15s. */
export const reconnectDelay = (attempt: number) => Math.min(15_000, 1000 * 2 ** Math.max(0, attempt));

// ---- reducer ----

export type Progress = { done: number; total: number | null; label: string | null };
export type ConsoleState = {
  events: RunEvent[];
  /** Number of oldest events dropped to keep the DOM small. */
  dropped: number;
  /** Highest event id seen: the SSE resume cursor. */
  lastId: number;
  progress: Progress | null;
  counts: Record<string, number>;
  summaries: RunEvent[];
  /** Failed assets seen so far (capped at MAX_FAILURES; `failuresDropped` counts the rest). */
  failures: FailedAsset[];
  failuresDropped: number;
  endStatus: RunStatus | null;
};

export type FailedAsset = { eventId: number; step: number | null; name: string; message: string | null };
export const MAX_FAILURES = 1000;

export const MAX_LINES = 3000;
export const initialConsole = (): ConsoleState => ({ events: [], dropped: 0, lastId: 0, progress: null, counts: {}, summaries: [], failures: [], failuresDropped: 0, endStatus: null });

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Tolerant: the backend's progress payload shape is not fixed yet (done/processed/completed + total). */
export function progressOf(ev: RunEvent): Progress | null {
  if (ev.type !== "progress" || !isObj(ev.data)) return null;
  const d = ev.data;
  const done = num(d.done) ?? num(d.processed) ?? num(d.completed) ?? num(d.current);
  if (done === null) return null;
  return { done, total: num(d.total), label: ev.message };
}

/** The asset result carried by an `asset` event (either the data itself or data.asset). */
export function assetOf(ev: RunEvent): { id?: string; fileName?: string; outcome?: string; message?: string } | null {
  if (ev.type !== "asset" || !isObj(ev.data)) return null;
  const d = isObj(ev.data.asset) ? ev.data.asset : ev.data;
  return { id: typeof d.id === "string" ? d.id : undefined, fileName: typeof d.fileName === "string" ? d.fileName : undefined, outcome: typeof d.outcome === "string" ? d.outcome : typeof d.status === "string" ? d.status : undefined, message: typeof d.message === "string" ? d.message : undefined };
}

/** Applies one event. Events at or below the cursor are ignored, so replays after a reconnect never duplicate. */
export function reduceEvent(s: ConsoleState, ev: RunEvent): ConsoleState {
  if (ev.id <= s.lastId) return s;
  const next: ConsoleState = { ...s, lastId: ev.id, events: [...s.events, ev] };
  if (next.events.length > MAX_LINES) {
    const cut = next.events.length - MAX_LINES;
    next.events = next.events.slice(cut);
    next.dropped = s.dropped + cut;
  }
  const p = progressOf(ev);
  if (p) next.progress = p;
  const a = assetOf(ev);
  if (a?.outcome) next.counts = { ...s.counts, [a.outcome]: (s.counts[a.outcome] ?? 0) + 1 };
  if (a?.outcome === "failed") {
    if (s.failures.length < MAX_FAILURES) {
      const step = isObj(ev.data) && typeof ev.data.step === "number" ? ev.data.step : null;
      next.failures = [...s.failures, { eventId: ev.id, step, name: a.fileName ?? a.id ?? "asset", message: a.message ?? null }];
    } else next.failuresDropped = s.failuresDropped + 1;
  }
  if (ev.type === "summary") next.summaries = [...s.summaries, ev];
  return next;
}

export function reduceEvents(s: ConsoleState, events: RunEvent[]): ConsoleState {
  return events.reduce(reduceEvent, s);
}

export const progressPercent = (p: Progress | null) => (p && p.total && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : null);

/** One display line for an event. */
export function eventText(ev: RunEvent): string {
  const a = assetOf(ev);
  if (a) return `${a.fileName ?? a.id ?? "asset"}: ${a.outcome ?? "?"}${a.message ? ` (${a.message})` : ""}`;
  return ev.message ?? (ev.data ? JSON.stringify(ev.data) : ev.type);
}

// ---- export ----

export const logAsText = (events: RunEvent[]) => events.map((e) => `${e.ts} ${e.level.toUpperCase().padEnd(7)} ${eventText(e)}`).join("\n") + (events.length ? "\n" : "");
export const logAsJson = (events: RunEvent[]) => JSON.stringify(events, null, 2) + "\n";

// ---- end-of-run summary ----

export type StepTotals = {
  found: number;
  /** Copied, moved or synced, depending on the operation. */
  done: number;
  doneLabel: "copied" | "moved" | "synced" | "done";
  /** Already present on the target (or metadata unchanged). */
  skipped: number;
  /** Skipped by the safety rule: the asset is in the target's trash and is never re-uploaded. */
  inTargetTrash: number;
  failed: number;
  cancelled: number;
  bytes: number;
  /** True when the step was a dry run: `done` then counts what would happen. */
  dryRun: boolean;
};
export type StepSummaryView = {
  step: number;
  status: string;
  message: string | null;
  /** Null when the step reported no counts (e.g. it could not start). */
  totals: StepTotals | null;
  failures: FailedAsset[];
};

/** Counts from a step summary object (the engine's StepSummary); null when it reported no assetsFound. */
export function totalsOf(sum: unknown): StepTotals | null {
  if (!isObj(sum) || num(sum.assetsFound) === null) return null;
  const n = (k: string) => num(sum[k]) ?? 0;
  const dryRun = sum.dryRun === true;
  const moved = dryRun ? n("wouldMove") : n("moved");
  const copied = dryRun ? n("wouldCopy") : n("copied");
  const synced = dryRun ? n("wouldSync") : n("synced");
  const pick = moved > 0 ? ([moved, "moved"] as const) : copied > 0 ? ([copied, "copied"] as const) : synced > 0 ? ([synced, "synced"] as const) : ([0, "done"] as const);
  return {
    found: n("assetsFound"),
    done: pick[0],
    doneLabel: pick[1],
    skipped: n("skipped") + n("unchanged"),
    inTargetTrash: n("inTargetTrash"),
    failed: n("failed"),
    cancelled: n("cancelled"),
    bytes: dryRun ? n("bytesToTransfer") : n("bytesCopied"),
    dryRun,
  };
}

/** "45 s", "12 min", "1 h 5 min" for a duration in milliseconds. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** Stored summary events of the form { step, status, summary } (see backend runner) into one block per step. Pure. */
export function stepSummaries(summaries: RunEvent[], failures: FailedAsset[] = []): StepSummaryView[] {
  const out: StepSummaryView[] = [];
  for (const ev of summaries) {
    if (!isObj(ev.data) || typeof ev.data.step !== "number") continue;
    const step = ev.data.step;
    const sum = isObj(ev.data.summary) ? ev.data.summary : null;
    const totals = totalsOf(sum);
    const existing = out.findIndex((x) => x.step === step);
    const view: StepSummaryView = {
      step,
      status: typeof ev.data.status === "string" ? ev.data.status : "unknown",
      message: ev.message,
      totals,
      failures: failures.filter((f) => f.step === step),
    };
    if (existing >= 0) out[existing] = view;
    else out.push(view);
  }
  return out.sort((a, b) => a.step - b.step);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

/** Console line filter: with `failuresOnly`, only warnings/errors and failed-asset lines remain (summaries are always kept). */
export function lineVisible(ev: RunEvent, f: { minRank: number; rank: number; showAssets: boolean; failuresOnly: boolean }): boolean {
  if (f.failuresOnly) {
    if (ev.type === "summary") return true;
    const a = assetOf(ev);
    return a ? a.outcome === "failed" : ev.level === "error" || ev.level === "warning";
  }
  return f.rank >= f.minRank && (f.showAssets || ev.type !== "asset");
}
