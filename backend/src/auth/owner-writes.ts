/** Process-local owner write admission, shared by authentication and deletion through their UserStore. */
import { HttpError } from "../http.ts";

export type OwnerWrite = <T>(work: () => Promise<T>) => Promise<T>;
export type OwnerWriteContext = { write: OwnerWrite };

type OwnerState = {
  closed: boolean;
  pending: Set<Promise<void>>;
  afterWrite?: () => Promise<void>;
};

const coordinators = new WeakMap<object, ReturnType<typeof createOwnerWrites>>();

/** One backend owns execution; all request writes and deletion must use the same UserStore object. */
export function ownerWritesFor(users: object) {
  let coordinator = coordinators.get(users);
  if (!coordinator) coordinators.set(users, coordinator = createOwnerWrites());
  return coordinator;
}

function createOwnerWrites() {
  const owners = new Map<string, OwnerState>();
  function state(ownerId: string) {
    let entry = owners.get(ownerId);
    if (!entry) owners.set(ownerId, entry = { closed: false, pending: new Set() });
    return entry;
  }
  return {
    async write<T>(ownerId: string, allowed: () => Promise<boolean>, work: () => Promise<T>): Promise<T> {
      const entry = state(ownerId);
      if (entry.closed) throw new HttpError(409, "This account is being deleted.");
      let settle!: () => void;
      const pending = new Promise<void>((r) => (settle = r));
      entry.pending.add(pending); // register before the asynchronous owner check
      try {
        if (!(await allowed()) || entry.closed) throw new HttpError(409, "This account is being deleted.");
        return await work();
      } finally {
        try {
          // An admitted schedule write can finish after a deletion timeout. Pause it again before releasing it.
          if (entry.closed) await entry.afterWrite?.();
        } finally {
          entry.pending.delete(pending);
          settle();
          if (!entry.closed && !entry.pending.size) owners.delete(ownerId);
        }
      }
    },
    close(ownerId: string, afterWrite: () => Promise<void>) {
      const entry = state(ownerId);
      entry.closed = true; // never reopened, including after a deletion timeout
      entry.afterWrite = afterWrite;
    },
    pending: (ownerId: string) => [...(owners.get(ownerId)?.pending ?? [])],
  };
}