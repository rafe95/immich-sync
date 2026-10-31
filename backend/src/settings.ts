/** /api/settings/retention and the periodic history pruning that applies it. */

import { HttpError, json, readJsonObject } from "./http.ts";
import { pruneHistory, type RunStore } from "./runs/store.ts";
import { systemTimers, type Timers } from "./scheduler.ts";

export type SettingsDeps = { runs: Pick<RunStore, "getRetentionDays" | "setRetentionDays"> };

export function createSettingsRoutes(deps: SettingsDeps) {
  return {
    getRetention: async () => json({ days: await deps.runs.getRetentionDays() }),
    putRetention: async (req: Request) => {
      const body = await readJsonObject(req);
      const days = body.days;
      if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650) {
        throw new HttpError(400, "days must be a whole number from 1 to 3650.");
      }
      await deps.runs.setRetentionDays(days);
      return json({ days });
    },
  };
}

export const PRUNE_INTERVAL_MS = 86_400_000;

/** Prunes once when started, then every 24 hours until stopped. Never throws; a failure is logged and retried next time. */
export function createRetentionPruner(deps: {
  runs: Pick<RunStore, "getRetentionDays" | "pruneBefore">;
  timers?: Timers;
  intervalMs?: number;
  log?: (message: string) => void;
}) {
  const timers = deps.timers ?? systemTimers;
  const every = deps.intervalMs ?? PRUNE_INTERVAL_MS;
  const log = deps.log ?? ((m: string) => console.log(`[retention] ${m}`));
  let handle: unknown = null;
  let stopped = true;

  async function prune() {
    try {
      const n = await pruneHistory(deps.runs as RunStore, new Date(timers.now()));
      if (n) log(`Pruned ${n} run(s) past the history retention.`);
    } catch (err) {
      console.error(`[retention] prune failed: ${(err as Error).message}`);
    }
  }
  const arm = () => {
    if (stopped) return;
    handle = timers.setTimeout(() => {
      void prune().finally(arm);
    }, every);
  };
  return {
    async start() {
      stopped = false;
      await prune();
      arm();
    },
    stop() {
      stopped = true;
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
    },
  };
}
