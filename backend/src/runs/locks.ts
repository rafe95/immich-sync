/**
 * Per-instance write locks. A run locks every instance it writes to (targets) and every instance it
 * moves from (move sources), all-or-nothing, so two runs never write the same target or trash from
 * the same source at once. Read-only use of an instance (a copy source) takes no lock, and runs on
 * unrelated instances proceed in parallel. Pure and in-memory: it knows nothing about jobs or the database.
 */

export type BusyInstance = { instanceId: string; heldBy: string };

export type LockHandle = {
  readonly owner: string;
  readonly instanceIds: readonly string[];
  /** Idempotent. */
  release(): void;
};

export class LockAbortedError extends Error {
  constructor() {
    super("Lock wait aborted.");
    this.name = "LockAbortedError";
  }
}

type Waiter = {
  owner: string;
  ids: string[];
  resolve(h: LockHandle): void;
  reject(e: Error): void;
  cleanup(): void;
};

/** The instances a step list needs exclusive access to: targets, plus sources of move steps. */
export function lockSetForSteps(steps: ReadonlyArray<{ operation: string; sourceId: string; targetId: string }>): string[] {
  const ids = new Set<string>();
  for (const s of steps) {
    ids.add(s.targetId);
    if (s.operation === "move") ids.add(s.sourceId);
  }
  return [...ids].sort();
}

export class InstanceLockManager {
  private held = new Map<string, string>();
  private waiters: Waiter[] = [];

  private busyFor(ids: string[]): BusyInstance[] {
    const busy: BusyInstance[] = [];
    for (const id of ids) {
      const owner = this.held.get(id) ?? this.waiters.find((w) => w.ids.includes(id))?.owner;
      if (owner) busy.push({ instanceId: id, heldBy: owner });
    }
    return busy;
  }

  private grant(owner: string, ids: string[]): LockHandle {
    for (const id of ids) this.held.set(id, owner);
    let released = false;
    return {
      owner,
      instanceIds: ids,
      release: () => {
        if (released) return;
        released = true;
        for (const id of ids) if (this.held.get(id) === owner) this.held.delete(id);
        this.drain();
      },
    };
  }

  /** Takes all locks now, or none. Does not queue; `busy` says who holds what. */
  tryAcquire(owner: string, instanceIds: readonly string[]): { ok: true; lock: LockHandle } | { ok: false; busy: BusyInstance[] } {
    const ids = [...new Set(instanceIds)].sort();
    const busy = ids.filter((id) => this.held.has(id)).map((id) => ({ instanceId: id, heldBy: this.held.get(id)! }));
    if (busy.length) return { ok: false, busy };
    return { ok: true, lock: this.grant(owner, ids) };
  }

  /**
   * Waits (first come, first served among overlapping requests) until every lock is free, then takes
   * them all at once. `onBusy` fires once if the request has to wait. Rejects with LockAbortedError on abort.
   */
  acquire(
    owner: string,
    instanceIds: readonly string[],
    opts: { signal?: AbortSignal; onBusy?: (busy: BusyInstance[]) => void } = {},
  ): Promise<LockHandle> {
    const ids = [...new Set(instanceIds)].sort();
    if (opts.signal?.aborted) return Promise.reject(new LockAbortedError());
    const busy = this.busyFor(ids);
    if (!busy.length) return Promise.resolve(this.grant(owner, ids));
    opts.onBusy?.(busy);
    return new Promise<LockHandle>((resolve, reject) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.cleanup();
        reject(new LockAbortedError());
        this.drain();
      };
      const waiter: Waiter = {
        owner, ids, resolve, reject,
        cleanup: () => opts.signal?.removeEventListener("abort", onAbort),
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private drain() {
    const blocked = new Set<string>();
    for (const w of [...this.waiters]) {
      const free = w.ids.every((id) => !this.held.has(id) && !blocked.has(id));
      if (free) {
        this.waiters = this.waiters.filter((x) => x !== w);
        w.cleanup();
        w.resolve(this.grant(w.owner, w.ids));
      } else {
        for (const id of w.ids) blocked.add(id);
      }
    }
  }

  snapshot(): { held: BusyInstance[]; waiting: Array<{ owner: string; instanceIds: string[] }> } {
    return {
      held: [...this.held].map(([instanceId, heldBy]) => ({ instanceId, heldBy })),
      waiting: this.waiters.map((w) => ({ owner: w.owner, instanceIds: [...w.ids] })),
    };
  }
}
