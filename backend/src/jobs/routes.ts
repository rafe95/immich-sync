/** /api/jobs and /api/schedules handlers. Mounted behind the central auth/CSRF guard. */

import { HttpError, json, readJsonObject } from "../http.ts";
import type { InstanceStore } from "../instances/store.ts";
import { isUuid } from "../instances/store.ts";
import type { RunManager } from "../runs/manager.ts";
import type { JobRecord, JobStore, ScheduleRecord } from "./store.ts";
import { checkStepInstances, hasMoveStep, nextRuns, validateJobInput, validateScheduleInput } from "./validation.ts";

export type JobRouteDeps = {
  jobs: JobStore;
  instances: Pick<InstanceStore, "list">;
  runs: Pick<RunManager, "start">;
  /** Default time zone for new schedules (the container's TZ). */
  defaultTimezone: string;
  /** Called after a change that can affect schedules (schedule put/delete, job update/delete). */
  onSchedulesChanged?: () => void;
  now?: () => Date;
};

type Ctx = { user: { id: string; username: string } };

/** Reads an optional JSON object body: an empty body counts as {}. */
async function readOptionalJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.clone().text();
  return text.trim() ? readJsonObject(req) : {};
}

export function createJobRoutes(deps: JobRouteDeps) {
  const { jobs } = deps;
  const now = deps.now ?? (() => new Date());

  const idOf = (req: Request) => {
    const id = (req as Request & { params?: Record<string, string> }).params?.id ?? "";
    if (!isUuid(id)) throw new HttpError(404, "Job not found.");
    return id;
  };
  const aliases = async () => new Map((await deps.instances.list()).map((i) => [i.id, i.alias]));

  const scheduleView = (s: ScheduleRecord | null) => {
    if (!s) return null;
    return { ...s, nextRuns: s.enabled ? nextRuns(s.cron, s.timezone, 3, now()) : [] };
  };
  const view = (j: JobRecord, names: Map<string, string>) => ({
    ...j,
    hasMove: hasMoveStep(j.steps),
    steps: j.steps.map((s) => ({ ...s, sourceAlias: names.get(s.sourceId) ?? null, targetAlias: names.get(s.targetId) ?? null })),
    schedule: scheduleView(j.schedule),
  });

  async function requireJob(ownerId: string, id: string) {
    const job = await jobs.get(ownerId, id);
    if (!job) throw new HttpError(404, "Job not found.");
    return job;
  }
  const requireInstances = async (steps: Parameters<typeof checkStepInstances>[0]) => {
    const problems = checkStepInstances(steps, new Set((await aliases()).keys()));
    if (problems.length) throw new HttpError(400, "Invalid job.", { problems });
  };

  return {
    list: async (_req: Request, ctx: Ctx) => {
      const names = await aliases();
      return json({ jobs: (await jobs.list(ctx.user.id)).map((j) => view(j, names)) });
    },

    get: async (req: Request, ctx: Ctx) => json(view(await requireJob(ctx.user.id, idOf(req)), await aliases())),

    create: async (req: Request, ctx: Ctx) => {
      const input = validateJobInput(await readJsonObject(req));
      await requireInstances(input.steps!);
      const created = await jobs.create(ctx.user.id, { name: input.name!, steps: input.steps! });
      return json(view(created, await aliases()), 201);
    },

    /** Partial update: `name` and/or `steps` (steps are replaced as a whole, in the given order). */
    update: async (req: Request, ctx: Ctx) => {
      const id = idOf(req);
      const body = await readJsonObject(req);
      const current = await requireJob(ctx.user.id, id);
      const patch = validateJobInput(body, { partial: true });
      if (patch.steps) await requireInstances(patch.steps);
      const updated = await jobs.update(ctx.user.id, id, patch);
      if (!updated) throw new HttpError(404, "Job not found.");
      // A schedule confirmed for a job without moves must not silently start trashing assets.
      if (patch.steps && hasMoveStep(patch.steps) && current.schedule) await jobs.revokeMoveConfirmation(ctx.user.id, id);
      deps.onSchedulesChanged?.();
      return json(view((await jobs.get(ctx.user.id, id))!, await aliases()));
    },

    remove: async (req: Request, ctx: Ctx) => {
      if (!(await jobs.delete(ctx.user.id, idOf(req)))) throw new HttpError(404, "Job not found.");
      deps.onSchedulesChanged?.();
      return json({ deleted: true });
    },

    /** Run now: body { dryRun?: boolean }. Responds 202 with the queued run; execution continues in the backend. */
    run: async (req: Request, ctx: Ctx) => {
      const id = idOf(req);
      const body = await readOptionalJson(req);
      if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") throw new HttpError(400, "dryRun must be a boolean.");
      const run = await deps.runs.start({ job: { id }, trigger: "manual", ownerId: ctx.user.id, startedBy: ctx.user.username, dryRun: body.dryRun === true });
      return json(run, 202);
    },

    listSchedules: async (_req: Request, ctx: Ctx) => {
      const names = new Map((await jobs.list(ctx.user.id)).map((j) => [j.id, j.name]));
      return json({ schedules: (await jobs.listSchedules(ctx.user.id)).map((s) => ({ ...scheduleView(s), jobName: names.get(s.jobId) ?? null })) });
    },

    getSchedule: async (req: Request, ctx: Ctx) => {
      const job = await requireJob(ctx.user.id, idOf(req));
      if (!job.schedule) throw new HttpError(404, "This job has no schedule.");
      return json(scheduleView(job.schedule));
    },

    /**
     * Creates or replaces the job's schedule. A job containing a move step needs `confirmMove: true`
     * (recorded as moveConfirmedAt) before the schedule may be enabled.
     */
    putSchedule: async (req: Request, ctx: Ctx) => {
      const id = idOf(req);
      const body = await readJsonObject(req);
      const job = await requireJob(ctx.user.id, id);
      const input = validateScheduleInput(body, { timezone: deps.defaultTimezone });
      let confirmedAt: Date | null = null;
      if (hasMoveStep(job.steps)) {
        if (input.confirmMove) confirmedAt = now();
        else if (job.schedule?.moveConfirmedAt) confirmedAt = new Date(job.schedule.moveConfirmedAt);
        if (input.enabled && !confirmedAt) {
          throw new HttpError(400, "This job moves assets, so a schedule must be confirmed explicitly: it will trash assets on the source servers on every run. Send confirmMove: true.", { confirmationRequired: true });
        }
      }
      const saved = await jobs.upsertSchedule(ctx.user.id, id, { cron: input.cron, timezone: input.timezone, enabled: input.enabled, catchUp: input.catchUp, moveConfirmedAt: confirmedAt });
      if (!saved) throw new HttpError(404, "Job not found.");
      deps.onSchedulesChanged?.();
      return json(scheduleView(saved), job.schedule ? 200 : 201);
    },

    deleteSchedule: async (req: Request, ctx: Ctx) => {
      if (!(await jobs.deleteSchedule(ctx.user.id, idOf(req)))) throw new HttpError(404, "This job has no schedule.");
      deps.onSchedulesChanged?.();
      return json({ deleted: true });
    },
  };
}
