/** Persistence of runs, their steps, and structured log events, plus history retention. */

import type { SQL } from "bun";
import type { StepOptions, Operation, OnError, OnFailure } from "../jobs/validation.ts";

export type RunStatus = "queued" | "running" | "completed" | "completed_with_failures" | "failed" | "cancelled" | "interrupted" | "skipped";
export type RunStepStatus = "pending" | "running" | "completed" | "completed_with_failures" | "error" | "cancelled" | "not_run";
export type RunTrigger = "manual" | "schedule";
export type EventLevel = "debug" | "info" | "warning" | "error";

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "completed_with_failures", "failed", "cancelled", "interrupted", "skipped"]);
export const isTerminal = (s: RunStatus) => TERMINAL_RUN_STATUSES.has(s);

/** One step of the settings snapshot. Contains aliases and ids only, never URLs or keys. */
export type RunSettingsStep = {
  position: number;
  operation: Operation;
  source: { id: string; alias: string };
  target: { id: string; alias: string };
  options: StepOptions;
  onFailure: OnFailure;
  onError: OnError;
};
export type RunSettings = { jobId: string | null; name: string; dryRun: boolean; steps: RunSettingsStep[] };

export type RunStepRecord = { position: number; status: RunStepStatus; summary: unknown | null; startedAt: string | null; finishedAt: string | null };

export type RunRecord = {
  id: string;
  ownerId: string;
  jobId: string | null;
  jobName: string;
  trigger: RunTrigger;
  startedBy: string;
  dryRun: boolean;
  status: RunStatus;
  settings: RunSettings;
  summary: unknown | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: RunStepRecord[];
};

export type RunEvent = { id: number; runId: string; ts: string; level: EventLevel; type: string; message: string | null; data: unknown | null };
export type NewEvent = { level: EventLevel; type: string; message?: string | null; data?: unknown };

export type NewRun = { ownerId: string; jobId: string | null; jobName: string; trigger: RunTrigger; startedBy: string; dryRun: boolean; settings: RunSettings };
/** A schedule firing that did not run: stored as a finished 'skipped' run with one explanatory log event. */
export type NewSkippedRun = { ownerId: string; jobId: string | null; jobName: string; settings: RunSettings; reason: string };
export type RunListQuery = { limit: number; offset: number; jobId?: string; status?: RunStatus; trigger?: RunTrigger };

export const DEFAULT_RETENTION_DAYS = 90;
export const RETENTION_SETTING_KEY = "run_retention_days";

export type RunStore = {
  createRun(input: NewRun): Promise<RunRecord>;
  /** Records a skipped schedule firing (trigger 'schedule', already finished, steps not_run, never lockable). */
  createSkippedRun(input: NewSkippedRun, at: Date): Promise<RunRecord>;
  /** Request-facing reads are scoped to the owner: another user's run is indistinguishable from a missing one. */
  getRun(ownerId: string, id: string): Promise<RunRecord | null>;
  listRuns(ownerId: string, q: RunListQuery): Promise<{ runs: RunRecord[]; total: number }>;
  // markRunning, finishRun, updateStep, appendEvent and listEvents are runner-internal: keyed by a run id that was
  // already authorised (created by the manager, or fetched through the owner-scoped getRun in a route).
  markRunning(id: string, at: Date): Promise<void>;
  finishRun(id: string, status: RunStatus, summary: unknown, at: Date): Promise<void>;
  updateStep(runId: string, position: number, patch: { status: RunStepStatus; summary?: unknown; startedAt?: Date; finishedAt?: Date }): Promise<void>;
  appendEvent(runId: string, ev: NewEvent): Promise<RunEvent>;
  /** Run counts since `since`: skipped and still-queued runs are not counted; failed = status failed or interrupted. */
  statsSince(ownerId: string, since: Date): Promise<{ runs: number; failed: number }>;
  /** Events with id greater than `after`, oldest first. */
  listEvents(runId: string, after: number, limit: number): Promise<RunEvent[]>;
  /** Cross-user reads for backend internals (scheduler bookkeeping); never reachable from a request. */
  system: {
    getRun(id: string): Promise<RunRecord | null>;
    listRuns(q: RunListQuery): Promise<{ runs: RunRecord[]; total: number }>;
  };
  /** Marks queued/running runs (left over from a previous process) as interrupted; returns their ids. */
  recoverInterrupted(at: Date): Promise<string[]>;
  getRetentionDays(): Promise<number>;
  setRetentionDays(days: number): Promise<void>;
  /** Deletes finished runs (and, by cascade, steps and events) created before the cutoff. */
  pruneBefore(cutoff: Date): Promise<number>;
};

export const clampRetentionDays = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 3650 ? v : DEFAULT_RETENTION_DAYS);

/** Applies the retention setting. Returns the number of runs deleted. */
export async function pruneHistory(store: RunStore, now = new Date()): Promise<number> {
  const days = await store.getRetentionDays();
  return store.pruneBefore(new Date(now.getTime() - days * 86_400_000));
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : (v ?? null));

function toStep(r: any): RunStepRecord {
  return { position: r.position, status: r.status, summary: parse(r.summary), startedAt: iso(r.started_at), finishedAt: iso(r.finished_at) };
}
function toRun(r: any, steps: RunStepRecord[]): RunRecord {
  return {
    id: r.id, ownerId: r.owner_id, jobId: r.job_id, jobName: r.job_name, trigger: r.trigger, startedBy: r.started_by, dryRun: r.dry_run, status: r.status,
    settings: parse(r.settings), summary: parse(r.summary), createdAt: iso(r.created_at)!, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), steps,
  };
}
function toEvent(r: any): RunEvent {
  return { id: Number(r.id), runId: r.run_id, ts: iso(r.ts)!, level: r.level, type: r.type, message: r.message, data: parse(r.data) };
}
const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

export function pgRunStore(sql: SQL): RunStore {
  // Loads step rows for just the given runs.
  async function pageSteps(rows: any[]): Promise<RunRecord[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const steps = await sql.unsafe(`select * from run_steps where run_id = any($1::uuid[]) order by run_id, position`, [`{${ids.join(",")}}`]);
    return rows.map((r) => toRun(r, steps.filter((s: any) => s.run_id === r.id).map(toStep)));
  }

  async function getRun(id: string, ownerId?: string): Promise<RunRecord | null> {
    const rows = ownerId === undefined ? await sql`select * from runs where id = ${id}` : await sql`select * from runs where id = ${id} and owner_id = ${ownerId}`;
    return (await pageSteps(rows))[0] ?? null;
  }
  async function listRuns(ownerId: string | undefined, q: RunListQuery) {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (ownerId !== undefined) conds.push(`owner_id = $${params.push(ownerId)}`);
    if (q.jobId) conds.push(`job_id = $${params.push(q.jobId)}`);
    if (q.status) conds.push(`status = $${params.push(q.status)}`);
    if (q.trigger) conds.push(`trigger = $${params.push(q.trigger)}`);
    const where = conds.length ? `where ${conds.join(" and ")}` : "";
    const [{ count }] = await sql.unsafe(`select count(*)::int as count from runs ${where}`, params);
    const rows = await sql.unsafe(`select * from runs ${where} order by created_at desc, id desc limit $${params.length + 1} offset $${params.length + 2}`, [...params, q.limit, q.offset]);
    return { runs: await pageSteps(rows), total: count as number };
  }

  return {
    system: { getRun: (id) => getRun(id), listRuns: (q) => listRuns(undefined, q) },
    async createRun(input) {
      const id = await sql.begin(async (tx) => {
        const [r] = await tx.unsafe(
          `insert into runs (owner_id, job_id, job_name, trigger, started_by, dry_run, settings) values ($1, $2, $3, $4, $5, $6, $7::text::jsonb) returning id`,
          [input.ownerId, input.jobId, input.jobName, input.trigger, input.startedBy, input.dryRun, JSON.stringify(input.settings)],
        );
        for (const s of input.settings.steps) await tx`insert into run_steps (run_id, position) values (${r.id}, ${s.position})`;
        return r.id as string;
      });
      return (await getRun(id))!;
    },
    async createSkippedRun(input, at) {
      const id = await sql.begin(async (tx) => {
        const [r] = await tx.unsafe(
          `insert into runs (owner_id, job_id, job_name, trigger, started_by, dry_run, status, settings, summary, created_at, finished_at)
           values ($1, $2, $3, 'schedule', 'schedule', false, 'skipped', $4::text::jsonb, $5::text::jsonb, $6, $6) returning id`,
          [input.ownerId, input.jobId, input.jobName, JSON.stringify(input.settings), JSON.stringify({ skipped: true, reason: input.reason }), at],
        );
        for (const s of input.settings.steps) await tx`insert into run_steps (run_id, position, status) values (${r.id}, ${s.position}, 'not_run')`;
        await tx`insert into run_events (run_id, level, type, message, ts) values (${r.id}, 'warning', 'log', ${input.reason}, ${at})`;
        return r.id as string;
      });
      return (await getRun(id))!;
    },
    getRun: (ownerId, id) => getRun(id, ownerId),
    listRuns: (ownerId, q) => listRuns(ownerId, q),
    async markRunning(id, at) {
      await sql`update runs set status = 'running', started_at = ${at} where id = ${id}`;
    },
    async finishRun(id, status, summary, at) {
      await sql`update runs set status = ${status}, summary = ${json(summary)}::text::jsonb, finished_at = ${at} where id = ${id}`;
    },
    async updateStep(runId, position, p) {
      await sql`update run_steps set status = ${p.status},
        summary = coalesce(${json(p.summary)}::text::jsonb, summary),
        started_at = coalesce(${p.startedAt ?? null}, started_at),
        finished_at = coalesce(${p.finishedAt ?? null}, finished_at)
        where run_id = ${runId} and position = ${position}`;
    },
    async appendEvent(runId, ev) {
      const [r] = await sql`insert into run_events (run_id, level, type, message, data)
        values (${runId}, ${ev.level}, ${ev.type}, ${ev.message ?? null}, ${json(ev.data)}::text::jsonb) returning *`;
      return toEvent(r);
    },
    async listEvents(runId, after, limit) {
      return (await sql`select * from run_events where run_id = ${runId} and id > ${after} order by id limit ${limit}`).map(toEvent);
    },
    async statsSince(ownerId, since) {
      const [r] = await sql`select count(*)::int as runs, (count(*) filter (where status in ('failed', 'interrupted')))::int as failed
        from runs where owner_id = ${ownerId} and created_at >= ${since} and status not in ('skipped', 'queued')`;
      return { runs: r.runs, failed: r.failed };
    },
    async recoverInterrupted(at) {
      return sql.begin(async (tx) => {
        const rows = await tx`select id from runs where status in ('queued', 'running') for update`;
        const ids = rows.map((r: any) => r.id as string);
        for (const id of ids) {
          await tx`update run_steps set status = 'error', finished_at = ${at} where run_id = ${id} and status = 'running'`;
          await tx`update run_steps set status = 'not_run' where run_id = ${id} and status = 'pending'`;
          await tx`update runs set status = 'interrupted', finished_at = ${at} where id = ${id}`;
          await tx`insert into run_events (run_id, level, type, message) values (${id}, 'error', 'log',
            'The application stopped while this run was in progress. It is marked interrupted; running it again is safe because assets already transferred are skipped.')`;
        }
        return ids;
      });
    },
    async getRetentionDays() {
      const [r] = await sql`select value from settings where key = ${RETENTION_SETTING_KEY}`;
      return clampRetentionDays(r ? parse(r.value) : undefined);
    },
    async setRetentionDays(days) {
      await sql`insert into settings (key, value) values (${RETENTION_SETTING_KEY}, ${JSON.stringify(clampRetentionDays(days))}::text::jsonb)
        on conflict (key) do update set value = excluded.value`;
    },
    async pruneBefore(cutoff) {
      const rows = await sql`delete from runs where created_at < ${cutoff} and status not in ('queued', 'running') returning id`;
      return rows.length;
    },
  };
}

/** In-memory store for tests; `eraseOwner` is the user-deletion eraser's hook (removes the owner's runs with their events). */
export function memoryRunStore(): RunStore & { events: RunEvent[]; runs: Map<string, RunRecord>; backdate(id: string, at: Date): void; eraseOwner(ownerId: string): void } {
  const runs = new Map<string, RunRecord>();
  const events: RunEvent[] = [];
  let nextId = 1;
  let retention = DEFAULT_RETENTION_DAYS;
  const copy = <T>(v: T): T => structuredClone(v);
  const listAll = (ownerId: string | undefined, q: RunListQuery) => {
    const all = [...runs.values()]
      .filter((r) => (ownerId === undefined || r.ownerId === ownerId) && (!q.jobId || r.jobId === q.jobId) && (!q.status || r.status === q.status) && (!q.trigger || r.trigger === q.trigger))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { runs: all.slice(q.offset, q.offset + q.limit).map(copy), total: all.length };
  };
  return {
    events,
    runs,
    system: {
      async getRun(id) {
        const r = runs.get(id);
        return r ? copy(r) : null;
      },
      async listRuns(q) {
        return listAll(undefined, q);
      },
    },
    backdate(id, at) {
      runs.get(id)!.createdAt = at.toISOString();
    },
    eraseOwner(ownerId) {
      const ids = new Set([...runs.values()].filter((r) => r.ownerId === ownerId).map((r) => r.id));
      for (const id of ids) runs.delete(id);
      for (let i = events.length - 1; i >= 0; i--) if (ids.has(events[i]!.runId)) events.splice(i, 1);
    },
    async createRun(input) {
      const r: RunRecord = {
        id: crypto.randomUUID(), ownerId: input.ownerId, jobId: input.jobId, jobName: input.jobName, trigger: input.trigger, startedBy: input.startedBy, dryRun: input.dryRun,
        status: "queued", settings: copy(input.settings), summary: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
        steps: input.settings.steps.map((s) => ({ position: s.position, status: "pending", summary: null, startedAt: null, finishedAt: null })),
      };
      runs.set(r.id, r);
      return copy(r);
    },
    async createSkippedRun(input, at) {
      const r: RunRecord = {
        id: crypto.randomUUID(), ownerId: input.ownerId, jobId: input.jobId, jobName: input.jobName, trigger: "schedule", startedBy: "schedule", dryRun: false,
        status: "skipped", settings: copy(input.settings), summary: { skipped: true, reason: input.reason }, createdAt: at.toISOString(), startedAt: null, finishedAt: at.toISOString(),
        steps: input.settings.steps.map((s) => ({ position: s.position, status: "not_run", summary: null, startedAt: null, finishedAt: null })),
      };
      runs.set(r.id, r);
      events.push({ id: nextId++, runId: r.id, ts: at.toISOString(), level: "warning", type: "log", message: input.reason, data: null });
      return copy(r);
    },
    async getRun(ownerId, id) {
      const r = runs.get(id);
      return r && r.ownerId === ownerId ? copy(r) : null;
    },
    async listRuns(ownerId, q) {
      return listAll(ownerId, q);
    },
    async markRunning(id, at) {
      Object.assign(runs.get(id)!, { status: "running", startedAt: at.toISOString() });
    },
    async finishRun(id, status, summary, at) {
      Object.assign(runs.get(id)!, { status, summary: copy(summary ?? null), finishedAt: at.toISOString() });
    },
    async updateStep(runId, position, p) {
      const s = runs.get(runId)!.steps.find((x) => x.position === position)!;
      s.status = p.status;
      if (p.summary !== undefined) s.summary = copy(p.summary);
      if (p.startedAt) s.startedAt = p.startedAt.toISOString();
      if (p.finishedAt) s.finishedAt = p.finishedAt.toISOString();
    },
    async appendEvent(runId, ev) {
      const e: RunEvent = { id: nextId++, runId, ts: new Date().toISOString(), level: ev.level, type: ev.type, message: ev.message ?? null, data: copy(ev.data ?? null) };
      events.push(e);
      return copy(e);
    },
    async listEvents(runId, after, limit) {
      return events.filter((e) => e.runId === runId && e.id > after).slice(0, limit).map(copy);
    },
    async statsSince(ownerId, since) {
      const rs = [...runs.values()].filter((r) => r.ownerId === ownerId && new Date(r.createdAt) >= since && r.status !== "skipped" && r.status !== "queued");
      return { runs: rs.length, failed: rs.filter((r) => r.status === "failed" || r.status === "interrupted").length };
    },
    async recoverInterrupted(at) {
      const ids: string[] = [];
      for (const r of runs.values()) {
        if (r.status !== "queued" && r.status !== "running") continue;
        for (const s of r.steps) {
          if (s.status === "running") Object.assign(s, { status: "error", finishedAt: at.toISOString() });
          else if (s.status === "pending") s.status = "not_run";
        }
        Object.assign(r, { status: "interrupted", finishedAt: at.toISOString() });
        events.push({ id: nextId++, runId: r.id, ts: at.toISOString(), level: "error", type: "log", message: "The application stopped while this run was in progress. It is marked interrupted; running it again is safe because assets already transferred are skipped.", data: null });
        ids.push(r.id);
      }
      return ids;
    },
    async getRetentionDays() {
      return retention;
    },
    async setRetentionDays(d) {
      retention = clampRetentionDays(d);
    },
    async pruneBefore(cutoff) {
      let n = 0;
      for (const r of [...runs.values()]) {
        if (isTerminal(r.status) && new Date(r.createdAt) < cutoff) {
          runs.delete(r.id);
          for (let i = events.length - 1; i >= 0; i--) if (events[i]!.runId === r.id) events.splice(i, 1);
          n++;
        }
      }
      return n;
    },
  };
}
