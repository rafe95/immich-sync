/** Run diagram model: step statuses, inferred preflight state, per-step progress and the graph. Pure, no Svelte. */
import type { Edge, Node } from "@xyflow/svelte";
import { progressOf, progressPercent, type ConsoleState, type Run, type RunStepSettings } from "../runs.ts";
import type { LabelEdgeData, StepNodeData, StepVisualStatus } from "./ops.ts";

export type PreflightState = "waiting_for_lock" | "checking" | "passed" | "failed";
export type PreflightNodeData = { state: PreflightState };

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

const X0 = 40;
// Wide enough that the edge label ("after checks") is not hidden behind the neighbouring nodes.
const DX = 360;

function chips(s: RunStepSettings): string[] {
  const out: string[] = [s.options.kind];
  if (s.operation !== "sync_metadata") out.push(s.options.metadata ? "with metadata" : "without metadata");
  if (s.options.includeTrashed) out.push("incl. source trash");
  if (s.options.dryRun) out.push("dry run");
  return out;
}

export function buildRunGraph(run: Run, state: ConsoleState): { nodes: Node[]; edges: Edge<LabelEdgeData>[] } {
  const pre = preflightState(run);
  const percents = stepPercents(state, run);
  const nodes: Node[] = [{ id: "preflight", type: "preflight", position: { x: X0, y: 0 }, data: { state: pre } satisfies PreflightNodeData }];
  const visuals: StepVisualStatus[] = [];
  run.settings.steps.forEach((s, i) => {
    const status = stepVisual(run.steps.find((x) => x.position === s.position)?.status ?? "pending");
    visuals.push(status);
    const data: StepNodeData = {
      position: s.position,
      operation: s.operation,
      source: s.source.alias,
      target: s.target.alias,
      chips: chips(s),
      status,
      percent: status === "running" ? (percents[s.position] ?? null) : null,
      problems: [],
      orientation: "horizontal",
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
