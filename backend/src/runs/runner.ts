/**
 * Run orchestration: lock, validate every instance, run steps strictly in order, honour on_failure /
 * on_error, record not_run steps, support cancellation. Engine work is delegated to a StepExecutor.
 */

import type { RunEventHub } from "./hub.ts";
import type { ProgressThrottle } from "./throttle.ts";
import type { ExecutionContext, InstanceProblem, StepExecutor, StepOutcome } from "./executor.ts";
import { InstanceLockManager, LockAbortedError, lockSetForSteps, type LockHandle } from "./locks.ts";
import type { NewEvent, RunEvent, RunSettingsStep, RunStatus, RunStepStatus, RunStore } from "./store.ts";

export type RunnerDeps = {
  store: RunStore;
  hub: RunEventHub;
  executor: StepExecutor;
  locks: InstanceLockManager;
  now?: () => Date;
  /** Limits persisted/streamed progress events (about one per second per step). Absent: no throttling. */
  throttle?: ProgressThrottle;
};

export const describeStep = (s: RunSettingsStep) => `${s.operation.replace("_", " ")} ${s.source.alias} -> ${s.target.alias}`;

/** Appends an event to the store, then pushes it to live subscribers. */
export async function emitEvent(deps: Pick<RunnerDeps, "store" | "hub" | "throttle">, runId: string, ev: NewEvent): Promise<RunEvent | null> {
  if (deps.throttle && !deps.throttle.admit(runId, ev)) return null; // held; written by flushProgress at the latest
  const saved = await deps.store.appendEvent(runId, ev);
  deps.hub.publishEvent(saved);
  return saved;
}

/** Writes the progress events held back for a run (or one step), so each step's last progress is always persisted. */
export async function flushProgress(deps: Pick<RunnerDeps, "store" | "hub" | "throttle">, runId: string, step?: number): Promise<void> {
  for (const ev of deps.throttle?.flush(runId, step) ?? []) {
    const saved = await deps.store.appendEvent(runId, ev);
    deps.hub.publishEvent(saved);
  }
}

/** Steps that make changes need the instance locks; dry-run steps only read. */
export function lockIdsFor(steps: readonly RunSettingsStep[]): string[] {
  return lockSetForSteps(steps.filter((s) => !s.options.dryRun).map((s) => ({ operation: s.operation, sourceId: s.source.id, targetId: s.target.id })));
}

export async function executeRun(deps: RunnerDeps, runId: string, signal: AbortSignal): Promise<RunStatus> {
  const { store, hub, executor, locks } = deps;
  const now = deps.now ?? (() => new Date());
  const log = (level: NewEvent["level"], message: string, data?: unknown, type = "log") => emitEvent(deps, runId, { level, type, message, data });
  const run = await store.system.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const steps = run.settings.steps;
  const aliasOf = new Map(steps.flatMap((s) => [[s.source.id, s.source.alias], [s.target.id, s.target.alias]] as const));

  const stepResults: Array<{ position: number; status: RunStepStatus; summary?: unknown }> = [];
  const markNotRun = async (from: number) => {
    for (const s of steps.slice(from)) {
      await store.updateStep(runId, s.position, { status: "not_run" });
      stepResults.push({ position: s.position, status: "not_run" });
    }
  };
  const finish = async (status: RunStatus, extra: Record<string, unknown> = {}) => {
    await flushProgress(deps, runId);
    deps.throttle?.forget(runId);
    await store.finishRun(runId, status, { steps: stepResults, ...extra }, now());
    await log(status === "failed" || status === "interrupted" ? "error" : "info", `Run ${status.replaceAll("_", " ")}.`, { status });
    hub.publishEnd(runId, status);
    return status;
  };

  let lock: LockHandle | null = null;
  try {
    // 1. Locks. Waiting is reported as "queued: waiting for <alias>".
    const lockIds = lockIdsFor(steps);
    if (lockIds.length) {
      try {
        lock = await locks.acquire(runId, lockIds, {
          signal,
          onBusy: (busy) => {
            const names = [...new Set(busy.map((b) => aliasOf.get(b.instanceId) ?? "another instance"))];
            void log("info", `queued: waiting for ${names.join(", ")}`, { waitingFor: busy.map((b) => ({ instanceId: b.instanceId, alias: aliasOf.get(b.instanceId) ?? null, heldByRun: b.heldBy })) });
          },
        });
      } catch (err) {
        if (!(err instanceof LockAbortedError)) throw err;
        await log("warning", "Cancelled while waiting for another run to finish.");
        await markNotRun(0);
        return await finish("cancelled");
      }
    }
    await store.markRunning(runId, now());
    await log("info", `${run.settings.dryRun ? "Dry run" : "Run"} started: ${run.jobName} (${steps.length} step${steps.length === 1 ? "" : "s"}).`);
    if (run.settings.dryRun && steps.length > 1) {
      await log("info", "Dry run: each step is reported separately; a later step's numbers cannot include what earlier steps would have transferred.");
    }

    const ctx: ExecutionContext = { runId, signal, log: async (ev) => void (await emitEvent(deps, runId, ev)) };

    // 2. Validate every instance before step 1.
    let problems: InstanceProblem[];
    try {
      problems = await executor.validateInstances(steps, ctx);
    } catch (err) {
      problems = [{ instanceId: "", alias: "", message: `Instance validation failed: ${(err as Error).message}` }];
    }
    if (problems.length) {
      for (const p of problems) await log("error", p.alias ? `${p.alias}: ${p.message}` : p.message, { instanceId: p.instanceId || null });
      await log("error", "No step was started because an instance failed validation. Nothing was changed.");
      await markNotRun(0);
      return await finish("failed", { problems });
    }
    if (signal.aborted) {
      await markNotRun(0);
      return await finish("cancelled");
    }

    // 3. Steps, strictly in order.
    let stopped = false;
    let cancelled = false;
    let anyFailures = false;
    let anyError = false;
    let stoppedOnError = false;
    for (const [index, step] of steps.entries()) {
      if (signal.aborted && !stopped) {
        cancelled = stopped = true;
        await log("warning", "Cancelled; remaining steps were not run.");
      }
      if (stopped) {
        await markNotRun(index);
        break;
      }
      await store.updateStep(runId, step.position, { status: "running", startedAt: now() });
      await log("info", `Step ${step.position}: ${describeStep(step)}${step.options.dryRun ? " (dry run)" : ""}`, { step: step.position });

      let outcome: StepOutcome;
      try {
        outcome = await executor.runStep({ ...ctx, position: step.position, step, dryRun: step.options.dryRun });
      } catch (err) {
        outcome = { status: "error", message: (err as Error).message || "Step failed." };
      }
      await flushProgress(deps, runId, step.position);
      const status: RunStepStatus = outcome.status;
      await store.updateStep(runId, step.position, { status, summary: outcome.summary ?? (outcome.message ? { message: outcome.message } : undefined), finishedAt: now() });
      stepResults.push({ position: step.position, status, summary: outcome.summary });
      await emitEvent(deps, runId, {
        level: status === "completed" ? "info" : status === "completed_with_failures" ? "warning" : status === "cancelled" ? "warning" : "error",
        type: "summary",
        message: `Step ${step.position} ${status.replaceAll("_", " ")}${outcome.message ? `: ${outcome.message}` : ""}`,
        data: { step: step.position, status, summary: outcome.summary ?? null },
      });

      if (status === "cancelled") cancelled = stopped = true;
      else if (status === "completed_with_failures") {
        anyFailures = true;
        if (step.onFailure === "stop") {
          stopped = true;
          await log("warning", `Step ${step.position} had failures and is set to stop the job; remaining steps were not run.`);
        }
      } else if (status === "error") {
        anyError = true;
        if (step.onError === "stop") {
          stopped = stoppedOnError = true;
          await log("error", `Step ${step.position} could not run; the job stops and remaining steps were not run.`);
        } else await log("warning", `Step ${step.position} could not run; continuing as configured.`);
      }
      if (!stopped && signal.aborted) {
        cancelled = stopped = true;
        await log("warning", "Cancelled; remaining steps were not run.");
      }
      if (stopped) await markNotRun(index + 1);
    }

    const status: RunStatus = cancelled ? "cancelled" : stoppedOnError ? "failed" : anyFailures || anyError ? "completed_with_failures" : "completed";
    return await finish(status);
  } catch (err) {
    // An orchestration bug or storage failure: never leave the run looking active.
    const message = (err as Error).message || "Unexpected error.";
    try {
      await flushProgress(deps, runId);
      for (const s of (await store.system.getRun(runId))?.steps ?? []) {
        if (s.status === "running") await store.updateStep(runId, s.position, { status: "error", finishedAt: now() });
        else if (s.status === "pending") await store.updateStep(runId, s.position, { status: "not_run" });
      }
      await log("error", `Run failed unexpectedly: ${message}`);
      await store.finishRun(runId, "failed", { steps: stepResults, error: message }, now());
    } catch {
      /* storage is down; startup recovery will mark the run interrupted */
    }
    hub.publishEnd(runId, "failed");
    return "failed";
  } finally {
    lock?.release();
  }
}
