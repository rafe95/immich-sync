/**
 * Owns run lifecycle in the backend process: builds the settings snapshot, persists the run, starts it
 * in the background (never tied to an HTTP request or browser connection), cancels, and recovers on startup.
 */

import { HttpError } from "../http.ts";
import type { InstanceStore } from "../instances/store.ts";
import { checkStepInstances, type StepInput } from "../jobs/validation.ts";
import type { JobStore } from "../jobs/store.ts";
import type { StepExecutor } from "./executor.ts";
import { RunEventHub } from "./hub.ts";
import { InstanceLockManager } from "./locks.ts";
import { emitEvent, executeRun } from "./runner.ts";
import { ProgressThrottle } from "./throttle.ts";
import type { RunRecord, RunSettings, RunStatus, RunStore, RunTrigger } from "./store.ts";

export type StartRequest = {
  /** Run a saved job, or give ad-hoc steps (the "Run" screen). */
  job?: { id: string } | { name: string; steps: StepInput[] };
  trigger: RunTrigger;
  /** The user the run is started for; a saved job must belong to them. */
  ownerId: string;
  startedBy: string;
  dryRun: boolean;
};

export type RunManagerDeps = {
  store: RunStore;
  jobs: JobStore;
  instances: Pick<InstanceStore, "list">;
  executor: StepExecutor;
  hub?: RunEventHub;
  locks?: InstanceLockManager;
  /** Injectable clock (ms) for progress throttling in tests. */
  nowMs?: () => number;
};

export type RunManager = ReturnType<typeof createRunManager>;

export function createRunManager(deps: RunManagerDeps) {
  const hub = deps.hub ?? new RunEventHub();
  const locks = deps.locks ?? new InstanceLockManager();
  const active = new Map<string, { controller: AbortController; done: Promise<RunStatus>; jobId: string | null; ownerId: string }>();
  const runnerDeps = { store: deps.store, hub, executor: deps.executor, locks, throttle: new ProgressThrottle(deps.nowMs) };

  async function snapshot(req: StartRequest): Promise<{ jobId: string | null; name: string; settings: RunSettings }> {
    let jobId: string | null = null;
    let name: string;
    let steps: StepInput[];
    if ("id" in req.job!) {
      const job = await deps.jobs.get(req.ownerId, req.job.id);
      if (!job) throw new HttpError(404, "Job not found.");
      jobId = job.id;
      name = job.name;
      steps = job.steps;
    } else {
      name = req.job!.name;
      steps = req.job!.steps;
    }
    const byId = new Map((await deps.instances.list(req.ownerId)).map((i) => [i.id, i.alias]));
    const missing = checkStepInstances(steps, new Set(byId.keys()));
    if (missing.length) throw new HttpError(400, "Some instances no longer exist.", { problems: missing });
    const settings: RunSettings = {
      jobId,
      name,
      dryRun: req.dryRun || steps.every((s) => s.options.dryRun),
      steps: steps.map((s, i) => ({
        position: i + 1,
        operation: s.operation,
        source: { id: s.sourceId, alias: byId.get(s.sourceId)! },
        target: { id: s.targetId, alias: byId.get(s.targetId)! },
        options: { ...s.options, dryRun: s.options.dryRun || req.dryRun },
        onFailure: s.onFailure,
        onError: s.onError,
      })),
    };
    return { jobId, name, settings };
  }

  function launch(run: RunRecord): void {
    const controller = new AbortController();
    const done = executeRun(runnerDeps, run.id, controller.signal).finally(() => active.delete(run.id));
    active.set(run.id, { controller, done, jobId: run.jobId, ownerId: run.ownerId });
  }

  return {
    hub,
    locks,
    store: deps.store,

    /** Creates the run and starts it in the background; resolves as soon as it is persisted as queued. */
    async start(req: StartRequest): Promise<RunRecord> {
      const { jobId, name, settings } = await snapshot(req);
      const run = await deps.store.createRun({ ownerId: req.ownerId, jobId, jobName: name, trigger: req.trigger, startedBy: req.startedBy, dryRun: settings.dryRun, settings });
      launch(run);
      return run;
    },

    /**
     * Records a schedule firing that did not run (previous run still active, move unconfirmed) as a 'skipped' run
     * in history. It is never launched, so it takes no lock and never counts as active.
     */
    async recordSkipped(jobId: string, reason: string): Promise<RunRecord> {
      const job = await deps.jobs.system.get(jobId);
      if (!job) throw new HttpError(404, "Job not found.");
      let snap: Awaited<ReturnType<typeof snapshot>>;
      try {
        snap = await snapshot({ job: { id: jobId }, trigger: "schedule", ownerId: job.ownerId, startedBy: "schedule", dryRun: false });
      } catch {
        // Instances may be gone; still record the skip.
        snap = { jobId, name: job.name, settings: { jobId, name: job.name, dryRun: false, steps: [] } };
      }
      return deps.store.createSkippedRun({ ownerId: job.ownerId, jobId: snap.jobId, jobName: snap.name, settings: snap.settings, reason }, new Date());
    },

    /** Requests cancellation of an active run; false when it is not active in this process. */
    cancel(runId: string): boolean {
      const entry = active.get(runId);
      if (!entry) return false;
      entry.controller.abort();
      return true;
    },

    isActive: (runId: string) => active.has(runId),
    /** For the scheduler's no-overlap rule. */
    activeRunForJob: (jobId: string) => [...active].find(([, e]) => e.jobId === jobId)?.[0] ?? null,
    activeRunIds: () => [...active.keys()],
    /** Resolves when every run started so far has finished (tests, graceful shutdown). */
    async whenIdle(): Promise<void> {
      while (active.size) await Promise.allSettled([...active.values()].map((e) => e.done));
    },

    /** Startup: runs left queued/running by a previous process become "interrupted". */
    async recoverInterrupted(): Promise<string[]> {
      const ids = await deps.store.recoverInterrupted(new Date());
      for (const id of ids) hub.publishEnd(id, "interrupted");
      return ids;
    },

    /** Shutdown: ask active runs to stop after their current batch. */
    abortAll() {
      for (const e of active.values()) e.controller.abort();
    },

    emit: (runId: string, ev: Parameters<typeof emitEvent>[2]) => emitEvent(runnerDeps, runId, ev),
  };
}
