/** Pure helpers for instance management on the dashboard: check stages, check summary, which jobs use an instance. */

import type { Instance, InstanceCheck } from "./api.ts";
import type { JobRecord } from "./jobs.ts";

// The core check runs these in order; version precedes key.
export const CHECK_STAGES = ["ping", "version", "key", "permissions"] as const;
export type CheckStage = (typeof CHECK_STAGES)[number];
export type StageState = "ok" | "failed" | "not run";

export function stageState(c: InstanceCheck, stage: CheckStage): StageState {
  if (!c.error) return "ok";
  const failedAt = CHECK_STAGES.indexOf(c.error.stage);
  const i = CHECK_STAGES.indexOf(stage);
  return i < failedAt ? "ok" : i === failedAt ? "failed" : "not run";
}

export type CheckTone = "surface" | "success" | "warning" | "error";
export function checkSummary(c: InstanceCheck | null): { label: string; tone: CheckTone } {
  if (!c) return { label: "Not checked", tone: "surface" };
  if (!c.ok) return { label: "Failed", tone: "error" };
  return c.warnings.length ? { label: "OK, with warnings", tone: "warning" } : { label: "OK", tone: "success" };
}

export type InstanceUse = { job: JobRecord; asSource: boolean; asTarget: boolean };

/** The jobs with at least one step reading from or writing to the instance, each once. */
export function jobsUsing(instanceId: string, jobs: readonly JobRecord[]): InstanceUse[] {
  const uses: InstanceUse[] = [];
  for (const job of jobs) {
    const asSource = job.steps.some((s) => s.sourceId === instanceId);
    const asTarget = job.steps.some((s) => s.targetId === instanceId);
    if (asSource || asTarget) uses.push({ job, asSource, asTarget });
  }
  return uses;
}

/** True when the instance cannot be deleted without first changing a job. */
export const inUse = (instanceId: string, jobs: readonly JobRecord[]) => jobsUsing(instanceId, jobs).length > 0;

export const firstInstanceIsDefault = (instances: readonly Pick<Instance, "id">[]) => instances.length === 0;
