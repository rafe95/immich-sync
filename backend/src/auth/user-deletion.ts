/**
 * Deleting a user: lock them out, stop their runs, then erase everything they own.
 *
 * Order: mark the user deleting (login and sessions refused, no new runs) → end their sessions → pause their
 * schedules → cancel their active runs through the run manager's AbortController path (which stops after the
 * current batch and never trashes unverified assets) → wait, bounded → erase their rows. If their runs do not stop
 * in time nothing is erased; the user stays locked out and a retry repeats the same sequence. Nothing here talks
 * to Immich.
 */

import type { SQL } from "bun";
import { HttpError } from "../http.ts";
import type { InstanceStore } from "../instances/store.ts";
import type { JobStore } from "../jobs/store.ts";
import { settlesWithin, type RunManager } from "../runs/manager.ts";
import type { RunStore } from "../runs/store.ts";
import type { SessionStore } from "./sessions.ts";
import type { UserStore } from "./users.ts";

export type UserDataCounts = { instances: number; jobs: number; runs: number };

export type UserDataEraser = {
  counts(userId: string): Promise<UserDataCounts>;
  /** Deletes the user's runs (with steps and events), jobs (with steps and schedules), instances and the user row. */
  erase(userId: string): Promise<void>;
};

export function pgUserDataEraser(sql: SQL): UserDataEraser {
  return {
    async counts(userId) {
      const [r] = await sql`select
        (select count(*)::int from instances where owner_id = ${userId}) as instances,
        (select count(*)::int from jobs where owner_id = ${userId}) as jobs,
        (select count(*)::int from runs where owner_id = ${userId}) as runs`;
      return { instances: r.instances, jobs: r.jobs, runs: r.runs };
    },
    async erase(userId) {
      await sql.begin(async (tx) => {
        await tx`delete from runs where owner_id = ${userId}`; // run_steps, run_events cascade
        await tx`delete from jobs where owner_id = ${userId}`; // job_steps, schedules cascade
        await tx`delete from instances where owner_id = ${userId}`;
        await tx`delete from users where id = ${userId}`; // sessions cascade
      });
    },
  };
}

/** The memory stores' erase hooks (see memoryUserStore, memoryInstanceStore, memoryJobStore, memoryRunStore). */
export type MemoryEraserStores = {
  users: { erase(id: string): void };
  instances: Pick<InstanceStore, "list"> & { eraseOwner(ownerId: string): void };
  jobs: Pick<JobStore, "list"> & { eraseOwner(ownerId: string): void };
  runs: Pick<RunStore, "listRuns"> & { eraseOwner(ownerId: string): void };
};

/** Same observable result as pgUserDataEraser, over the in-memory stores used by tests. */
export function memoryUserDataEraser(s: MemoryEraserStores): UserDataEraser {
  return {
    async counts(userId) {
      return {
        instances: (await s.instances.list(userId)).length,
        jobs: (await s.jobs.list(userId)).length,
        runs: (await s.runs.listRuns(userId, { limit: 0, offset: 0 })).total,
      };
    },
    async erase(userId) {
      s.runs.eraseOwner(userId);
      s.jobs.eraseOwner(userId);
      s.instances.eraseOwner(userId);
      s.users.erase(userId);
    },
  };
}

export type UserDeletionDeps = {
  users: Pick<UserStore, "markDeleting">;
  sessions: Pick<SessionStore, "deleteForUser">;
  jobs: { system: Pick<JobStore["system"], "disableSchedules"> };
  manager: Pick<RunManager, "cancelOwner" | "pendingStarts" | "waitFor">;
  eraser: UserDataEraser;
  /** Overall bound on waiting for the user's runs to stop. */
  timeoutMs?: number;
  now?: () => Date;
};

export type UserDeletionResult = "deleted" | "stopping" | "not_found";

export const DELETE_TIMEOUT_MS = 60_000;

export function createUserDeletion(deps: UserDeletionDeps) {
  const timeoutMs = deps.timeoutMs ?? DELETE_TIMEOUT_MS;
  const now = deps.now ?? (() => new Date());
  return {
    /** Throws HttpError 409 for self-deletion and LastAdminError for the last administrator. */
    async remove(actorId: string, userId: string): Promise<UserDeletionResult> {
      if (actorId === userId) throw new HttpError(409, "You cannot delete your own account.");
      if (!(await deps.users.markDeleting(userId, now()))) return "not_found";
      await deps.sessions.deleteForUser(userId);
      await deps.jobs.system.disableSchedules(userId);

      // From here no new start() for this user gets past its deleting check. A start that passed it just before is
      // still in flight (pendingStarts) and may launch a run after a scan, so scan again until a scan finds neither
      // active runs nor starts in flight, all within one overall deadline.
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const runIds = deps.manager.cancelOwner(userId);
        const starts = deps.manager.pendingStarts(userId);
        if (!runIds.length && !starts.length) break;
        if (!(await deps.manager.waitFor(runIds, deadline - Date.now()))) return "stopping";
        if (!(await settlesWithin(starts, deadline - Date.now()))) return "stopping";
      }
      await deps.eraser.erase(userId);
      return "deleted";
    },
  };
}
