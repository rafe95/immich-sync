/** Persistence of jobs, their ordered steps, and schedules. */

import type { SQL } from "bun";
import type { JobInput, Operation, OnError, OnFailure, StepInput, StepOptions } from "./validation.ts";

export type StepRecord = StepInput & { id: string; position: number };

export type ScheduleRecord = {
  id: string;
  jobId: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  catchUp: boolean;
  moveConfirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JobRecord = {
  id: string;
  ownerId: string;
  name: string;
  steps: StepRecord[];
  schedule: ScheduleRecord | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleWrite = { cron: string; timezone: string; enabled: boolean; catchUp: boolean; moveConfirmedAt: Date | null };

export type JobStore = {
  list(ownerId: string): Promise<JobRecord[]>;
  get(ownerId: string, id: string): Promise<JobRecord | null>;
  create(ownerId: string, input: JobInput): Promise<JobRecord>;
  /** Replaces the steps when given (positions renumbered from 1). */
  update(ownerId: string, id: string, patch: Partial<JobInput>): Promise<JobRecord | null>;
  delete(ownerId: string, id: string): Promise<boolean>;
  /** Insert or replace the job's single schedule; null when the job does not exist. */
  upsertSchedule(ownerId: string, jobId: string, input: ScheduleWrite): Promise<ScheduleRecord | null>;
  deleteSchedule(ownerId: string, jobId: string): Promise<boolean>;
  listSchedules(ownerId: string): Promise<ScheduleRecord[]>;
  /** Clears the move confirmation and pauses the schedule (used when a move step is added). */
  revokeMoveConfirmation(ownerId: string, jobId: string): Promise<void>;
  /** Owner-independent access for the scheduler and the run manager's skip records only; request handlers never use it. */
  system: {
    get(id: string): Promise<JobRecord | null>;
    listSchedules(): Promise<ScheduleRecord[]>;
    /** Pauses every schedule of the owner's jobs. */
    disableSchedules(ownerId: string): Promise<void>;
  };
};

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

function toStep(r: any): StepRecord {
  return {
    id: r.id,
    position: r.position,
    operation: r.operation as Operation,
    sourceId: r.source_id,
    targetId: r.target_id,
    options: (typeof r.options === "string" ? JSON.parse(r.options) : r.options) as StepOptions,
    onFailure: r.on_failure as OnFailure,
    onError: r.on_error as OnError,
  };
}

function toSchedule(r: any): ScheduleRecord {
  return {
    id: r.id,
    jobId: r.job_id,
    cron: r.cron,
    timezone: r.timezone,
    enabled: r.enabled,
    catchUp: r.catch_up,
    moveConfirmedAt: iso(r.move_confirmed_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

const SCHEDULE_COLS = "id, job_id, cron, timezone, enabled, catch_up, move_confirmed_at, created_at, updated_at";

export function pgJobStore(sql: SQL): JobStore {
  async function assemble(jobs: any[]): Promise<JobRecord[]> {
    if (!jobs.length) return [];
    const ids = new Set(jobs.map((j) => j.id));
    const steps = (await sql`select * from job_steps order by job_id, position`).filter((s: any) => ids.has(s.job_id));
    const schedules = (await sql.unsafe(`select ${SCHEDULE_COLS} from schedules`)).filter((s: any) => ids.has(s.job_id));
    return jobs.map((j) => ({
      id: j.id,
      ownerId: j.owner_id,
      name: j.name,
      steps: steps.filter((s: any) => s.job_id === j.id).map(toStep),
      schedule: schedules.filter((s: any) => s.job_id === j.id).map(toSchedule)[0] ?? null,
      createdAt: iso(j.created_at)!,
      updatedAt: iso(j.updated_at)!,
    }));
  }

  async function insertSteps(tx: SQL, jobId: string, steps: StepInput[]) {
    for (const [i, s] of steps.entries()) {
      await tx.unsafe(
        `insert into job_steps (job_id, position, operation, source_id, target_id, options, on_failure, on_error)
         values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8)`,
        [jobId, i + 1, s.operation, s.sourceId, s.targetId, JSON.stringify(s.options), s.onFailure, s.onError],
      );
    }
  }

  const getJob = async (ownerId: string, id: string) => (await assemble(await sql`select * from jobs where id = ${id} and owner_id = ${ownerId}`))[0] ?? null;
  const owns = async (ownerId: string, id: string) => (await sql`select id from jobs where id = ${id} and owner_id = ${ownerId}`).length > 0;

  return {
    async list(ownerId) {
      return assemble(await sql`select * from jobs where owner_id = ${ownerId} order by lower(name), created_at`);
    },
    get: getJob,
    async create(ownerId, input) {
      const id = await sql.begin(async (tx) => {
        const [j] = await tx`insert into jobs (name, owner_id) values (${input.name}, ${ownerId}) returning id`;
        await insertSteps(tx, j.id, input.steps);
        return j.id as string;
      });
      return (await getJob(ownerId, id))!;
    },
    async update(ownerId, id, patch) {
      const ok = await sql.begin(async (tx) => {
        const [j] = await tx`select id from jobs where id = ${id} and owner_id = ${ownerId} for update`;
        if (!j) return false;
        if (patch.name !== undefined) await tx`update jobs set name = ${patch.name} where id = ${id}`;
        if (patch.steps) {
          await tx`delete from job_steps where job_id = ${id}`;
          await insertSteps(tx, id, patch.steps);
        }
        await tx`update jobs set updated_at = now() where id = ${id}`;
        return true;
      });
      return ok ? getJob(ownerId, id) : null;
    },
    async delete(ownerId, id) {
      return (await sql`delete from jobs where id = ${id} and owner_id = ${ownerId} returning id`).length > 0;
    },
    async upsertSchedule(ownerId, jobId, s) {
      if (!(await owns(ownerId, jobId))) return null;
      const [r] = await sql.unsafe(
        `insert into schedules (job_id, cron, timezone, enabled, catch_up, move_confirmed_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (job_id) do update set cron = excluded.cron, timezone = excluded.timezone, enabled = excluded.enabled,
           catch_up = excluded.catch_up, move_confirmed_at = excluded.move_confirmed_at, updated_at = now()
         returning ${SCHEDULE_COLS}`,
        [jobId, s.cron, s.timezone, s.enabled, s.catchUp, s.moveConfirmedAt],
      );
      return toSchedule(r);
    },
    async deleteSchedule(ownerId, jobId) {
      return (await sql`delete from schedules where job_id = ${jobId} and job_id in (select id from jobs where owner_id = ${ownerId}) returning id`).length > 0;
    },
    async listSchedules(ownerId) {
      return (await sql.unsafe(`select ${SCHEDULE_COLS} from schedules where job_id in (select id from jobs where owner_id = $1) order by created_at`, [ownerId])).map(toSchedule);
    },
    async revokeMoveConfirmation(ownerId, jobId) {
      await sql`update schedules set move_confirmed_at = null, enabled = false, updated_at = now()
        where job_id = ${jobId} and job_id in (select id from jobs where owner_id = ${ownerId})`;
    },
    system: {
      async get(id) {
        return (await assemble(await sql`select * from jobs where id = ${id}`))[0] ?? null;
      },
      async listSchedules() {
        return (await sql.unsafe(`select ${SCHEDULE_COLS} from schedules order by created_at`)).map(toSchedule);
      },
      async disableSchedules(ownerId) {
        await sql`update schedules set enabled = false, updated_at = now() where job_id in (select id from jobs where owner_id = ${ownerId})`;
      },
    },
  };
}

/** In-memory store for tests; `eraseOwner` is the user-deletion eraser's hook (removes the owner's jobs with their steps and schedules). */
export function memoryJobStore(): JobStore & { eraseOwner(ownerId: string): void } {
  const jobs = new Map<string, JobRecord>();
  const stamp = () => new Date().toISOString();
  const withSteps = (steps: StepInput[]): StepRecord[] => steps.map((s, i) => ({ ...structuredClone(s), id: crypto.randomUUID(), position: i + 1 }));
  const copy = (j: JobRecord): JobRecord => structuredClone(j);
  /** The job when it exists and belongs to the owner; a foreign job behaves as missing. */
  const owned = (ownerId: string, id: string) => {
    const j = jobs.get(id);
    return j && j.ownerId === ownerId ? j : undefined;
  };
  return {
    eraseOwner(ownerId) {
      for (const j of [...jobs.values()]) if (j.ownerId === ownerId) jobs.delete(j.id);
    },
    async list(ownerId) {
      return [...jobs.values()].filter((j) => j.ownerId === ownerId).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())).map(copy);
    },
    async get(ownerId, id) {
      const j = owned(ownerId, id);
      return j ? copy(j) : null;
    },
    async create(ownerId, input) {
      const j: JobRecord = { id: crypto.randomUUID(), ownerId, name: input.name, steps: withSteps(input.steps), schedule: null, createdAt: stamp(), updatedAt: stamp() };
      jobs.set(j.id, j);
      return copy(j);
    },
    async update(ownerId, id, patch) {
      const j = owned(ownerId, id);
      if (!j) return null;
      if (patch.name !== undefined) j.name = patch.name;
      if (patch.steps) j.steps = withSteps(patch.steps);
      j.updatedAt = stamp();
      return copy(j);
    },
    async delete(ownerId, id) {
      return owned(ownerId, id) ? jobs.delete(id) : false;
    },
    async upsertSchedule(ownerId, jobId, s) {
      const j = owned(ownerId, jobId);
      if (!j) return null;
      j.schedule = {
        id: j.schedule?.id ?? crypto.randomUUID(), jobId, cron: s.cron, timezone: s.timezone, enabled: s.enabled, catchUp: s.catchUp,
        moveConfirmedAt: s.moveConfirmedAt?.toISOString() ?? null, createdAt: j.schedule?.createdAt ?? stamp(), updatedAt: stamp(),
      };
      return structuredClone(j.schedule);
    },
    async deleteSchedule(ownerId, jobId) {
      const j = owned(ownerId, jobId);
      if (!j?.schedule) return false;
      j.schedule = null;
      return true;
    },
    async listSchedules(ownerId) {
      return [...jobs.values()].filter((j) => j.ownerId === ownerId).flatMap((j) => (j.schedule ? [structuredClone(j.schedule)] : []));
    },
    async revokeMoveConfirmation(ownerId, jobId) {
      const s = owned(ownerId, jobId)?.schedule;
      if (s) Object.assign(s, { moveConfirmedAt: null, enabled: false, updatedAt: stamp() });
    },
    system: {
      async get(id) {
        const j = jobs.get(id);
        return j ? copy(j) : null;
      },
      async listSchedules() {
        return [...jobs.values()].flatMap((j) => (j.schedule ? [structuredClone(j.schedule)] : []));
      },
      async disableSchedules(ownerId) {
        for (const j of jobs.values()) if (j.ownerId === ownerId && j.schedule) Object.assign(j.schedule, { enabled: false, updatedAt: stamp() });
      },
    },
  };
}
