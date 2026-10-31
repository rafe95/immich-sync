/** In-process fan-out of live run events to SSE subscribers. Persistence is the store's job; this only pushes. */

import type { RunEvent, RunStatus } from "./store.ts";

export type HubMessage = { kind: "event"; event: RunEvent } | { kind: "end"; status: RunStatus };

export class RunEventHub {
  private subs = new Map<string, Set<(m: HubMessage) => void>>();

  subscribe(runId: string, fn: (m: HubMessage) => void): () => void {
    let set = this.subs.get(runId);
    if (!set) this.subs.set(runId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.subs.delete(runId);
    };
  }

  private send(runId: string, m: HubMessage) {
    for (const fn of [...(this.subs.get(runId) ?? [])]) fn(m);
  }

  publishEvent(event: RunEvent) {
    this.send(event.runId, { kind: "event", event });
  }

  /** The run reached a terminal status; streams close after draining. */
  publishEnd(runId: string, status: RunStatus) {
    this.send(runId, { kind: "end", status });
  }

  subscriberCount(runId: string) {
    return this.subs.get(runId)?.size ?? 0;
  }
}
