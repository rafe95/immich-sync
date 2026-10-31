/** Wires the job and run subsystems together so index.ts and tests build them the same way. */

import type { InstanceStore } from "./instances/store.ts";
import type { JobStore } from "./jobs/store.ts";
import { createRunManager } from "./runs/manager.ts";
import type { StepExecutor } from "./runs/executor.ts";
import type { RunStore } from "./runs/store.ts";
import { createScheduler, type SchedulerDeps } from "./scheduler.ts";

export type JobRunServicesOptions = {
  instances: Pick<InstanceStore, "list">;
  jobs: JobStore;
  runs: RunStore;
  executor: StepExecutor;
  defaultTimezone?: string;
  heartbeatMs?: number;
  scheduler?: Pick<SchedulerDeps, "timers" | "log">;
  /** Injectable clocks for tests. */
  nowMs?: () => number;
  now?: () => Date;
};

export function createJobRunServices(o: JobRunServicesOptions) {
  const manager = createRunManager({ store: o.runs, jobs: o.jobs, instances: o.instances, executor: o.executor, nowMs: o.nowMs });
  const scheduler = createScheduler({
    jobs: o.jobs,
    runs: manager,
    lastScheduledRunAt: async (jobId) => {
      const { runs } = await o.runs.system.listRuns({ limit: 1, offset: 0, jobId, trigger: "schedule" });
      return runs[0] ? new Date(runs[0].createdAt) : null;
    },
    ...o.scheduler,
  });
  // Schedule or job changes take effect without a restart; reload() does nothing until the scheduler has been started.
  const onSchedulesChanged = () => void scheduler.reload().catch((err) => console.error(`[scheduler] reload failed: ${(err as Error).message}`));
  return {
    manager,
    scheduler,
    jobs: {
      onSchedulesChanged,
      jobs: o.jobs,
      instances: o.instances,
      runs: manager,
      defaultTimezone: o.defaultTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    },
    runs: { runs: manager, heartbeatMs: o.heartbeatMs },
    dashboard: { instances: o.instances, jobs: o.jobs, runs: o.runs, now: o.now },
    settings: { runs: o.runs },
  };
}
