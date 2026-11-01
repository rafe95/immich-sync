/** Pure graph model of the job pipeline editor: one vertical column of step nodes. No Svelte. */
import type { Edge, Node } from "@xyflow/svelte";
import type { Instance } from "../api.ts";
import { moveItem, needsMoveConfirmation, scheduleSummary, validateStep, type ScheduleRecord, type StepForm } from "../jobs.ts";
import type { LabelEdgeData, StepNodeData } from "./ops.ts";

export const STEP_GAP = 200;
export const PIPELINE_X = 0;
export const SCHEDULE_ID = "schedule";
export const ADD_ID = "add";

export type ScheduleNodeData = { summary: string; nextRun: string | null; catchUp: boolean; enabled: boolean; warning: string | null; cron: string; timezone: string };
export type AddNodeData = { disabled: boolean };

type PipelineInput = { steps: StepForm[]; schedule: ScheduleRecord | null; instances: Instance[]; selectedKey: string | null };

const aliasOf = (instances: Instance[], id: string) => instances.find((i) => i.id === id)?.alias ?? "Not chosen";

export function stepProblems(step: StepForm, index: number, instances: Instance[]): string[] {
  const out = validateStep(step, index);
  for (const id of new Set([step.sourceId, step.targetId])) {
    const inst = instances.find((i) => i.id === id);
    if (inst?.lastCheck?.versionStatus === "unsupported") out.push(`${inst.alias} runs an unsupported Immich version`);
  }
  return out;
}

export function scheduleWarning(schedule: ScheduleRecord | null, steps: StepForm[]): string | null {
  if (!schedule) return null;
  return needsMoveConfirmation(steps, schedule.enabled) && !schedule.moveConfirmedAt ? "Scheduled move not confirmed" : null;
}

function chips(s: StepForm): string[] {
  const out: string[] = [s.kind === "all" ? "photos and videos" : `${s.kind} only`];
  if (s.rangeMode === "all") out.push("all assets");
  else if (s.rangeMode === "lastDays") out.push(`last ${s.lastDays} days`);
  else if (s.rangeMode === "window") out.push(`${s.from || "…"} to ${s.to || "…"}`);
  if (s.operation !== "sync_metadata") out.push(s.metadata ? "metadata on" : "metadata off");
  if (s.includeAlbums) out.push("albums");
  if (s.includeTags) out.push("tags");
  if (s.includeEdits) out.push("edits");
  if (s.includeTrashed) out.push("source trash");
  return out;
}

export function buildPipeline(input: PipelineInput): { nodes: Node[]; edges: Edge<LabelEdgeData>[] } {
  const { steps, schedule, instances, selectedKey } = input;
  const nodes: Node[] = [];
  const edges: Edge<LabelEdgeData>[] = [];
  const offset = schedule ? 1 : 0;
  const y = (i: number) => (offset + i) * STEP_GAP;

  if (schedule) {
    const data: ScheduleNodeData = {
      summary: scheduleSummary(schedule), nextRun: schedule.nextRuns[0] ?? null, catchUp: schedule.catchUp, enabled: schedule.enabled, warning: scheduleWarning(schedule, steps),
      cron: schedule.cron, timezone: schedule.timezone,
    };
    nodes.push({ id: SCHEDULE_ID, type: "schedule", position: { x: PIPELINE_X, y: 0 }, data, draggable: false, selectable: false });
  }

  steps.forEach((s, i) => {
    const data: StepNodeData = {
      position: i + 1, operation: s.operation, source: aliasOf(instances, s.sourceId), target: aliasOf(instances, s.targetId), chips: chips(s),
      status: "idle", percent: null, problems: stepProblems(s, i, instances), orientation: "vertical",
    };
    nodes.push({ id: s.key, type: "step", position: { x: PIPELINE_X, y: y(i) }, data, selected: s.key === selectedKey });
  });

  nodes.push({ id: ADD_ID, type: "add", position: { x: PIPELINE_X, y: y(steps.length) }, data: { disabled: false } satisfies AddNodeData, draggable: false, selectable: false });

  if (schedule && steps.length) {
    edges.push({ id: `${SCHEDULE_ID}>${steps[0]!.key}`, type: "label", source: SCHEDULE_ID, target: steps[0]!.key, data: { label: "starts", tone: "neutral", style: schedule.enabled ? "solid" : "muted" } });
  }
  for (let i = 0; i < steps.length - 1; i++) {
    const s = steps[i]!;
    const label = `on failure · ${s.onFailure === "stop" ? "stop job" : "continue"}`;
    const data: LabelEdgeData = { label, tone: "neutral", style: "solid", ...(s.onError !== s.onFailure ? { icon: "on-error" as const } : {}) };
    edges.push({ id: `${s.key}>${steps[i + 1]!.key}`, type: "label", source: s.key, target: steps[i + 1]!.key, data });
  }
  return { nodes, edges };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Insertion index for a drop at `y`, measured from the first step's top. Rounds to the nearest gap, clamped to 0..count. */
export const dropIndex = (y: number, count: number): number => clamp(Math.round(y / STEP_GAP), 0, count);

/** Moves the step with `key` to the slot nearest `y` (measured from the first step's top). */
export function reorderByY(steps: StepForm[], key: string, y: number): StepForm[] {
  const from = steps.findIndex((s) => s.key === key);
  if (from < 0) return [...steps];
  return moveItem(steps, from, clamp(Math.round(y / STEP_GAP), 0, steps.length - 1));
}
