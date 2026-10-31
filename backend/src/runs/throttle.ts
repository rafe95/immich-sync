/**
 * Limits how many `progress` events a step persists: at most one per interval per (run, step). A progress event that
 * arrives inside the interval is held (newest wins) and written when the step ends, so the final one is never lost.
 * Only progress events are throttled; log, asset and summary events always pass.
 */

import type { NewEvent } from "./store.ts";

export class ProgressThrottle {
  private lastAt = new Map<string, number>();
  private held = new Map<string, NewEvent>();

  constructor(
    private now: () => number = () => Date.now(),
    private intervalMs = 1000,
  ) {}

  private key(runId: string, ev: NewEvent): string {
    const step = (ev.data as { step?: unknown } | null | undefined)?.step;
    return `${runId}:${typeof step === "number" ? step : "-"}`;
  }

  /** True when the event should be written now; otherwise it is held for a later write or flush. */
  admit(runId: string, ev: NewEvent): boolean {
    if (ev.type !== "progress") return true;
    const k = this.key(runId, ev);
    const t = this.now();
    const last = this.lastAt.get(k);
    if (last === undefined || t - last >= this.intervalMs) {
      this.lastAt.set(k, t);
      this.held.delete(k);
      return true;
    }
    this.held.set(k, ev);
    return false;
  }

  /** Removes and returns the held (final) progress events of a run, optionally only for one step. */
  flush(runId: string, step?: number): NewEvent[] {
    const out: NewEvent[] = [];
    for (const [k, ev] of [...this.held]) {
      if (!k.startsWith(`${runId}:`) || (step !== undefined && k !== `${runId}:${step}`)) continue;
      this.held.delete(k);
      out.push(ev);
    }
    return out;
  }

  /** Forgets a finished run's bookkeeping (flush first). */
  forget(runId: string): void {
    for (const k of [...this.lastAt.keys()]) if (k.startsWith(`${runId}:`)) this.lastAt.delete(k);
  }
}
