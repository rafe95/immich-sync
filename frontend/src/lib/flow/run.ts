/** Run diagram model: step statuses, inferred preflight state, per-step progress and the graph. Pure, no Svelte. */
import type { Edge, Node } from "@xyflow/svelte";
import { formatDuration, progressOf, progressPercent, statusLabel, stepSummaries, totalsOf, type ConsoleState, type Run, type RunStepSettings } from "../runs.ts";
import type { LabelEdgeData, StepNodeData, StepVisualStatus } from "./ops.ts";

export type PreflightState = "waiting_for_lock" | "checking" | "passed" | "failed";
export type PreflightNodeData = {
  state: PreflightState;
  /** Distinct instances the run touches; shown only once the checks passed. */
  instances: number;
  /** Write locks are known to be held only for a real run whose checks passed. */
  locksTaken: boolean;
};
export type PhaseSegment = { label: string; state: "done" | "active" | "todo" };
export type RunStepNodeData = {
  position: number;
  operation: StepNodeData["operation"];
  source: string;
  target: string;
  status: StepVisualStatus;
  /** Header text at the right: a duration when finished, a percent while running. */
  right: string | null;
  lines: string[];
  percent: number | null;
  /** Segmented phase bar for a running step; null when no phase has been reported (a plain progress bar is used then). */
  phases: PhaseSegment[] | null;
  dryRun: boolean;
};

const VISUAL: Record<string, StepVisualStatus> = {
  pending: "waiting",
  running: "running",
  completed: "done",
  completed_with_failures: "done_with_failures",
  error: "failed",
  cancelled: "cancelled",
  not_run: "not_run",
};
export const stepVisual = (status: string): StepVisualStatus => VISUAL[status] ?? "waiting";

const TERMINAL = new Set(["completed", "completed_with_failures", "failed", "cancelled", "interrupted", "skipped"]);

/** There is no typed preflight event, so the state is inferred from the run and step statuses. */
export function preflightState(run: Run): PreflightState {
  if (run.status === "queued") return "waiting_for_lock";
  if (run.steps.some((s) => s.status !== "pending")) return "passed";
  if (TERMINAL.has(run.status)) return "failed";
  return "checking";
}

/** Latest progress percent per step position. Progress without `data.step` belongs to the running step. */
export function stepPercents(state: ConsoleState, run: Run): Record<number, number | null> {
  const running = run.steps.find((s) => s.status === "running")?.position;
  const out: Record<number, number | null> = {};
  for (const ev of state.events) {
    const p = progressOf(ev);
    if (!p) continue;
    const d = ev.data as { step?: unknown };
    const step = typeof d.step === "number" ? d.step : running;
    if (step === undefined) continue;
    out[step] = progressPercent(p);
  }
  return out;
}

export type StepLive = { done: number; total: number | null; phase: string | null; percent: number | null; sawRunning: boolean };

/** Latest progress and engine phase per step. Events without `data.step` belong to the running step. */
export function stepLive(state: ConsoleState, run: Run): Record<number, StepLive> {
  const running = run.steps.find((s) => s.status === "running")?.position;
  const out: Record<number, StepLive> = {};
  for (const ev of state.events) {
    const d = (ev.data && typeof ev.data === "object" ? ev.data : {}) as { step?: unknown; phase?: unknown };
    const step = typeof d.step === "number" ? d.step : running;
    if (step === undefined) continue;
    const phase = typeof d.phase === "string" ? d.phase : null;
    const p = progressOf(ev);
    const cur = out[step] ?? { done: 0, total: null, phase: null, percent: null, sawRunning: false };
    if (p) out[step] = { ...cur, done: p.done, total: p.total, percent: progressPercent(p), phase: phase ?? cur.phase };
    else if (ev.type === "log" && phase) out[step] = { ...cur, phase, sawRunning: cur.sawRunning || phase === "running" };
  }
  return out;
}

/** Phase bar for a running step from the engine's own phase names; null while none has been reported. */
export function phaseSegments(operation: StepNodeData["operation"], live: StepLive | undefined): PhaseSegment[] | null {
  if (!live || (!live.phase && !live.sawRunning)) return null;
  const metadataOnly = operation === "sync_metadata";
  const labels = metadataOnly ? ["Plan", "Metadata"] : ["Plan", "Upload + verify", "Metadata", "Finalize"];
  // copying: upload; metadata-wait and metadata: metadata; finalizing: last. preflight/running are still planning.
  const idxOf = (phase: string | null): number => {
    if (metadataOnly) return phase === "metadata" || phase === "metadata-wait" || phase === "finalizing" ? 1 : 0;
    return phase === "copying" ? 1 : phase === "metadata" || phase === "metadata-wait" ? 2 : phase === "finalizing" ? 3 : 0;
  };
  const active = idxOf(live.phase);
  return labels.map((label, i) => ({ label, state: i < active ? "done" : i === active ? "active" : "todo" }));
}

/** "step 2 of 3" while the run is running and a step has started; null otherwise. */
export function stepProgressLabel(run: Run): string | null {
  const total = run.settings.steps.length;
  if (run.status !== "running" || !total) return null;
  const cur = run.steps.find((s) => s.status === "running")?.position ?? run.steps.filter((s) => s.status !== "pending").length;
  return cur > 0 ? `step ${cur} of ${total}` : null;
}

export function triggerLabel(trigger: string): string {
  return trigger === "schedule" || trigger === "scheduled" ? "Scheduled" : trigger === "manual" ? "Manual" : trigger.charAt(0).toUpperCase() + trigger.slice(1);
}

const X0 = 40;
// Wide enough that the edge label ("after checks") is not hidden behind the neighbouring nodes.
const DX = 360;

function stepLines(run: Run, state: ConsoleState, s: RunStepSettings, status: StepVisualStatus, live: StepLive | undefined): string[] {
  const rs = run.steps.find((x) => x.position === s.position);
  const t = stepSummaries(state.summaries, state.failures).find((b) => b.step === s.position)?.totals ?? totalsOf(rs?.summary);
  const failedLive = state.failures.filter((f) => f.step === s.position).length;
  if (status === "waiting" || status === "idle") return [s.position === 1 ? "Waiting for preflight" : `Waiting for step ${s.position - 1}`];
  if (status === "not_run") return ["Not run"];
  if (status === "running") {
    const out: string[] = [];
    if (live && (live.total !== null || live.done > 0)) out.push(live.total !== null ? `${live.done} / ${live.total} assets` : `${live.done} assets`);
    if (failedLive) out.push(`${failedLive} failed`);
    return out.length ? out : ["Starting…"];
  }
  if (t) {
    const out = [`${t.done} ${t.dryRun ? "would be " : ""}${t.doneLabel}${t.skipped ? ` · ${t.skipped} skipped` : ""}`];
    const extra = [t.failed ? `${t.failed} failed` : "", t.inTargetTrash ? `${t.inTargetTrash} in target trash` : "", t.cancelled ? `${t.cancelled} cancelled` : ""].filter(Boolean);
    if (extra.length) out.push(extra.join(" · "));
    return out;
  }
  return [statusLabel(rs?.status ?? status)];
}

export function buildRunGraph(run: Run, state: ConsoleState): { nodes: Node[]; edges: Edge<LabelEdgeData>[] } {
  const pre = preflightState(run);
  const live = stepLive(state, run);
  const instanceIds = new Set(run.settings.steps.flatMap((s) => [s.source.id, s.target.id]));
  const nodes: Node[] = [
    {
      id: "preflight",
      type: "preflight",
      position: { x: X0, y: 20 },
      data: { state: pre, instances: instanceIds.size, locksTaken: pre === "passed" && !run.dryRun } satisfies PreflightNodeData,
    },
  ];
  const visuals: StepVisualStatus[] = [];
  run.settings.steps.forEach((s, i) => {
    const rs = run.steps.find((x) => x.position === s.position);
    const status = stepVisual(rs?.status ?? "pending");
    visuals.push(status);
    const l = live[s.position];
    const percent = status === "running" ? (l?.percent ?? null) : null;
    const dur = rs?.startedAt && rs.finishedAt && status !== "running" ? formatDuration(Date.parse(rs.finishedAt) - Date.parse(rs.startedAt)) : null;
    const data: RunStepNodeData = {
      position: s.position,
      operation: s.operation,
      source: s.source.alias,
      target: s.target.alias,
      status,
      right: status === "running" ? (percent !== null ? `${percent}%` : null) : dur,
      lines: stepLines(run, state, s, status, l),
      percent,
      phases: status === "running" ? phaseSegments(s.operation, l) : null,
      dryRun: s.options.dryRun,
    };
    nodes.push({ id: `step-${s.position}`, type: "step", position: { x: X0 + (i + 1) * DX, y: 0 }, data: data as unknown as Record<string, unknown> });
  });

  const edges: Edge<LabelEdgeData>[] = [];
  run.settings.steps.forEach((s, i) => {
    const leftDone = i === 0 ? pre === "passed" : visuals[i - 1] === "done" || visuals[i - 1] === "done_with_failures";
    const style: LabelEdgeData["style"] = visuals[i] === "running" ? "running" : leftDone ? "solid" : "muted";
    edges.push({
      id: `e-${i}`,
      source: i === 0 ? "preflight" : `step-${run.settings.steps[i - 1]!.position}`,
      target: `step-${s.position}`,
      type: "label",
      data: { label: i === 0 ? "after checks" : "then", tone: "neutral", style },
    });
  });
  return { nodes, edges };
}
