/** Shared flow vocabulary: tones, labels and node/edge data shapes. Pure, no Svelte. */
import type { Health } from "../dashboard.ts";
import { OP_LABEL } from "../jobs.ts";
import type { Operation } from "../runs.ts";

export type OpTone = "primary" | "warning" | "tertiary";
export type EdgeStyle = "solid" | "running" | "muted" | "warning";
export type StepVisualStatus = "idle" | "waiting" | "running" | "done" | "done_with_failures" | "failed" | "cancelled" | "not_run";

const TONE: Record<Operation, OpTone> = { copy: "primary", move: "warning", sync_metadata: "tertiary" };
export const opTone = (op: Operation): OpTone => TONE[op];
export const opLabel = (op: Operation): string => OP_LABEL[op];

export type InstanceNodeData = {
  alias: string;
  isDefault: boolean;
  version: string | null;
  checkedAt: string | null;
  health: Health;
  activity: { kind: "lock" | "reading" | "waiting"; job: string } | null;
  selected?: boolean;
};

export type StepNodeData = {
  position: number;
  operation: Operation;
  source: string;
  target: string;
  chips: string[];
  status: StepVisualStatus;
  percent: number | null;
  problems: string[];
  orientation: "vertical" | "horizontal";
};

export type LabelEdgeData = { label: string; tone: OpTone | "neutral"; style: EdgeStyle; icon?: "on-error"; jobId?: string };
