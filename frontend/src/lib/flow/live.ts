/** Live run data for the dashboard map: progress percentages, recent log lines and counts. Pure, no Svelte. */
import { eventText, type ConsoleState, type Run, type RunEvent } from "../runs.ts";
import type { MapInput } from "./map.ts";
import { stepPercents } from "./run.ts";

/** Position of the step that is running now, or null when none is. */
export const currentStepOf = (run: Run): number | null => run.steps.find((s) => s.status === "running")?.position ?? null;

/** Latest progress percent of each active run's running step, keyed by run id. Runs without a known percent are left out. */
export function livePercents(active: MapInput["active"], stateOf: (runId: string) => ConsoleState | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of active) {
    if (a.queued) continue;
    const state = stateOf(a.run.id);
    const step = currentStepOf(a.run);
    if (!state || step === null) continue;
    const percent = stepPercents(state, a.run)[step];
    if (percent !== null && percent !== undefined) out[a.run.id] = percent;
  }
  return out;
}

/** The map input with live percentages applied to the matching active runs. Returns the input itself when there are none. */
export function withLivePercents(input: MapInput, percents: Record<string, number>): MapInput {
  if (Object.keys(percents).length === 0) return input;
  return { ...input, active: input.active.map((a) => (a.run.id in percents ? { ...a, percent: percents[a.run.id]! } : a)) };
}

/** The last `n` log lines worth showing: progress ticks are skipped. */
export function recentLines(events: readonly RunEvent[], n = 4): string[] {
  return events
    .filter((e) => e.type !== "progress")
    .slice(-n)
    .map(eventText);
}

const OUTCOME_ORDER = ["copied", "moved", "synced", "skipped", "in-target-trash", "cancelled", "failed"];

/** "34 copied · 132 skipped · 2 failed": known outcomes in a fixed order, then others alphabetically; zeros omitted. */
export function countsText(counts: Record<string, number>): string {
  const names = Object.keys(counts).filter((k) => (counts[k] ?? 0) > 0);
  const rank = (k: string) => (OUTCOME_ORDER.includes(k) ? OUTCOME_ORDER.indexOf(k) : OUTCOME_ORDER.length);
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return names.length ? names.map((k) => `${counts[k]} ${k}`).join(" · ") : "No assets processed yet";
}
