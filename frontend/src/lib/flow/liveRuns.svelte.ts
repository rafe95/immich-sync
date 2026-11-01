import { SvelteMap } from "svelte/reactivity";
import { createRunEvents, type RunEvents } from "../runEvents.svelte.ts";
import type { api as Api } from "../session.svelte.ts";

/**
 * One live event stream per active run, started and stopped as runs appear and finish.
 * Reads are reactive, so a view updates when a stream starts or receives events. Closing a stream never affects a run.
 */
export function createLiveRuns(api: Pick<typeof Api, "getRun" | "getRunLog">) {
  const streams = new SvelteMap<string, RunEvents>();
  return {
    get: (runId: string): RunEvents | undefined => streams.get(runId),
    /** Starts streams for newly active runs and stops those no longer wanted. Safe to call on every refresh. */
    sync(runIds: readonly string[]) {
      const wanted = new Set(runIds);
      for (const [id, s] of streams) {
        if (wanted.has(id)) continue;
        s.stop();
        streams.delete(id);
      }
      for (const id of wanted) {
        if (streams.has(id)) continue;
        const s = createRunEvents(api, id, "live");
        streams.set(id, s);
        s.start();
      }
    },
    stopAll() {
      for (const s of streams.values()) s.stop();
      streams.clear();
    },
  };
}
