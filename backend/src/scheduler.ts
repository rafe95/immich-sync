/**
 * Backend-owned scheduler. Each enabled schedule gets one timer that fires at the next cron occurrence in the
 * schedule's IANA time zone and starts the job through the run manager (the same path as a manual run).
 * Rules: no overlap (a firing while the job's previous run is queued/running is skipped and logged), paused
 * schedules never fire, missed occurrences while the process was down are not caught up unless catch_up is set
 * (then one run), and a job with a move step fires only when the schedule carries a move confirmation.
 */

import { Cron } from "croner";
import type { JobStore, ScheduleRecord } from "./jobs/store.ts";
import { hasMoveStep } from "./jobs/validation.ts";
import type { RunManager } from "./runs/manager.ts";

export type Timers = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const systemTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type SchedulerLog = (level: "info" | "warning" | "error", message: string, data?: Record<string, unknown>) => void;

export type SchedulerDeps = {
  jobs: Pick<JobStore, "get" | "listSchedules">;
  runs: Pick<RunManager, "start" | "activeRunForJob" | "recordSkipped">;
  /** When the job last started a schedule-triggered run (for catch-up); null if never. */
  lastScheduledRunAt?: (jobId: string) => Promise<Date | null>;
  timers?: Timers;
  log?: SchedulerLog;
};

/** setTimeout cannot exceed 2^31-1 ms; longer waits are re-armed in hops. */
const MAX_DELAY_MS = 2_000_000_000;

export function createScheduler(deps: SchedulerDeps) {
  const timers = deps.timers ?? systemTimers;
  const log: SchedulerLog = deps.log ?? ((level, message) => console[level === "info" ? "log" : level === "warning" ? "warn" : "error"](`[scheduler] ${message}`));
  const armed = new Map<string, unknown>(); // schedule id -> timer handle
  let running = false;
  let generation = 0; // bumped on every (re)load so stale timers do nothing

  const clearAll = () => {
    for (const h of armed.values()) timers.clearTimeout(h);
    armed.clear();
  };

  const cronOf = (s: ScheduleRecord) => new Cron(s.cron, { timezone: s.timezone, paused: true });

  /** Skipped firings are written to history (status 'skipped'), not only to the process log. */
  async function recordSkip(jobId: string, reason: string) {
    try {
      await deps.runs.recordSkipped(jobId, reason);
    } catch (err) {
      log("error", `Could not record the skipped run: ${(err as Error).message}`, { jobId });
    }
  }

  async function fire(s: ScheduleRecord, reason: "due" | "catch-up"): Promise<"started" | "skipped"> {
    const job = await deps.jobs.get(s.jobId);
    if (!job) return "skipped";
    const tag = `schedule for "${job.name}"`;
    const active = deps.runs.activeRunForJob(s.jobId);
    if (active) {
      log("warning", `Skipped ${tag}: the previous run (${active}) is still queued or running.`, { jobId: s.jobId, activeRunId: active });
      await recordSkip(s.jobId, "skipped: previous run still active");
      return "skipped";
    }
    if (hasMoveStep(job.steps) && !s.moveConfirmedAt) {
      log("warning", `Skipped ${tag}: the job moves assets and the schedule has no move confirmation.`, { jobId: s.jobId });
      await recordSkip(s.jobId, "skipped: this job moves assets and its schedule has no move confirmation");
      return "skipped";
    }
    try {
      const run = await deps.runs.start({ job: { id: s.jobId }, trigger: "schedule", startedBy: "schedule", dryRun: false });
      log("info", `Started ${tag}${reason === "catch-up" ? " (catch-up of a missed occurrence)" : ""}: run ${run.id}.`, { jobId: s.jobId, runId: run.id });
      return "started";
    } catch (err) {
      log("error", `Could not start ${tag}: ${(err as Error).message}`, { jobId: s.jobId });
      return "skipped";
    }
  }

  function arm(s: ScheduleRecord, after: Date, gen: number) {
    let due: Date | null;
    try {
      due = cronOf(s).nextRun(after);
    } catch (err) {
      log("error", `Schedule ${s.id} has an unusable cron or time zone: ${(err as Error).message}`);
      return;
    }
    if (!due) return;
    const hop = () => {
      if (!running || gen !== generation) return;
      const wait = due!.getTime() - timers.now();
      if (wait > 0) {
        // Not yet due (long wait or a timer that fired early): wait the remainder.
        armed.set(s.id, timers.setTimeout(hop, Math.min(wait, MAX_DELAY_MS)));
        return;
      }
      // Re-arm first, from the current time: occurrences that passed while the loop was blocked are not caught up.
      arm(s, new Date(Math.max(timers.now(), due!.getTime())), gen);
      void fire(s, "due");
    };
    const wait = Math.max(0, due.getTime() - timers.now());
    armed.set(s.id, timers.setTimeout(hop, Math.min(wait, MAX_DELAY_MS)));
  }

  async function load(opts: { catchUp: boolean }) {
    const gen = ++generation;
    clearAll();
    const schedules = (await deps.jobs.listSchedules()).filter((s) => s.enabled);
    if (!running || gen !== generation) return;
    const nowMs = timers.now();
    for (const s of schedules) {
      arm(s, new Date(nowMs), gen);
      if (opts.catchUp && s.catchUp && deps.lastScheduledRunAt) {
        try {
          const missed = cronOf(s).previousRuns(1, new Date(nowMs))[0];
          const last = (await deps.lastScheduledRunAt(s.jobId)) ?? new Date(s.updatedAt);
          const since = Math.max(last.getTime(), new Date(s.updatedAt).getTime());
          if (missed && missed.getTime() > since && missed.getTime() <= nowMs) await fire(s, "catch-up");
        } catch (err) {
          log("error", `Catch-up check failed for schedule ${s.id}: ${(err as Error).message}`);
        }
      }
    }
  }

  return {
    /** Loads schedules and arms timers; runs catch-up once for schedules that opted in. */
    async start() {
      running = true;
      await load({ catchUp: true });
    },
    /** Re-reads all schedules (after create/update/delete). A no-op until start(). No catch-up. */
    async reload() {
      if (running) await load({ catchUp: false });
    },
    /** Cancels every timer; in-flight runs are the run manager's concern. */
    stop() {
      running = false;
      generation++;
      clearAll();
    },
    /** For tests and diagnostics. */
    armedCount: () => armed.size,
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
