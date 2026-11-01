/** Pure presentation helpers for the Jobs list cards and the Schedule editor's Next runs panel. */

import { describeCron, type ScheduleRecord } from "./jobs.ts";
import type { Operation } from "./runs.ts";

/** Skeleton tonal badge preset for an operation chip (theme tokens only, so light and dark both work). */
export const opBadgeClass = (op: Operation): string =>
  op === "move" ? "preset-tonal-warning" : op === "copy" ? "preset-tonal-primary" : "preset-tonal-tertiary";

export type ScheduleState = {
  kind: "none" | "paused" | "active";
  /** Plain-language reading of the cron, or "Cron <expr>". */
  what: string;
  timezone: string;
  /** Upcoming runs as ISO strings; empty while paused or when none were reported. */
  next: string[];
  /** Enabled schedule on a job with a move step that carries no move confirmation. */
  moveUnconfirmed: boolean;
};

export function scheduleState(schedule: ScheduleRecord | null, jobHasMove: boolean): ScheduleState {
  if (!schedule) return { kind: "none", what: "", timezone: "", next: [], moveUnconfirmed: false };
  const what = describeCron(schedule.cron) ?? `Cron ${schedule.cron}`;
  const enabled = schedule.enabled;
  return {
    kind: enabled ? "active" : "paused",
    what,
    timezone: schedule.timezone,
    next: enabled ? schedule.nextRuns : [],
    moveUnconfirmed: enabled && jobHasMove && !schedule.moveConfirmedAt,
  };
}

/** "in 6 days", "in 3 hours", "in 12 minutes"; null for a past or invalid time. */
export function relativeIn(iso: string, now: Date = new Date()): string | null {
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.round(ms / 60_000);
  if (min < 1) return "in under a minute";
  if (min < 60) return `in ${min} ${min === 1 ? "minute" : "minutes"}`;
  const h = Math.round(min / 60);
  if (h < 48) return `in ${h} ${h === 1 ? "hour" : "hours"}`;
  const d = Math.round(h / 24);
  return `in ${d} days`;
}
