/** /api/runs handlers: start ad-hoc runs, history, cancel, and the event log (SSE and JSON). */

import { HttpError, json, readJsonObject } from "../http.ts";
import { isUuid } from "../instances/store.ts";
import { normalizeName, normalizeSteps } from "../jobs/validation.ts";
import type { HubMessage } from "./hub.ts";
import type { RunManager } from "./manager.ts";
import { isTerminal, type RunStatus } from "./store.ts";

export type RunRouteDeps = {
  runs: RunManager;
  /** SSE keep-alive interval; short in tests. */
  heartbeatMs?: number;
};

type Ctx = { user: { id: string; username: string } };
const STATUSES = new Set<RunStatus>(["queued", "running", "completed", "completed_with_failures", "failed", "cancelled", "interrupted", "skipped"]);
const EVENT_PAGE = 500;

function intParam(url: URL, name: string, def: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return def;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) throw new HttpError(400, `${name} must be an integer from ${min} to ${max}.`);
  return n;
}

export function createRunRoutes(deps: RunRouteDeps) {
  const { runs } = deps;
  const { store, hub } = runs;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;

  const idOf = (req: Request) => {
    const id = (req as Request & { params?: Record<string, string> }).params?.id ?? "";
    if (!isUuid(id)) throw new HttpError(404, "Run not found.");
    return id;
  };
  async function requireRun(ownerId: string, id: string) {
    const run = await store.getRun(ownerId, id);
    if (!run) throw new HttpError(404, "Run not found.");
    return run;
  }
  const afterOf = (req: Request, url: URL): number => {
    const raw = req.headers.get("last-event-id") ?? url.searchParams.get("after");
    if (raw === null || raw === "") return 0;
    if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, "after / Last-Event-ID must be a non-negative integer event id.");
    return Number(raw);
  };

  return {
    /** Ad-hoc one-off run from the Run screen: { name?, steps, dryRun? }. */
    start: async (req: Request, ctx: Ctx) => {
      const body = await readJsonObject(req);
      const problems: string[] = [];
      const name = body.name === undefined ? "One-off run" : normalizeName(body.name, problems);
      const steps = normalizeSteps(body.steps, problems);
      if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") problems.push("dryRun must be a boolean.");
      if (problems.length) throw new HttpError(400, "Invalid run.", { problems });
      const run = await runs.start({ job: { name: name!, steps: steps! }, trigger: "manual", ownerId: ctx.user.id, startedBy: ctx.user.username, dryRun: body.dryRun === true });
      return json(run, 202);
    },

    list: async (req: Request, ctx: Ctx) => {
      const url = new URL(req.url);
      const limit = intParam(url, "limit", 50, 1, 200);
      const offset = intParam(url, "offset", 0, 0, 1_000_000);
      const status = url.searchParams.get("status");
      if (status && !STATUSES.has(status as RunStatus)) throw new HttpError(400, "Unknown status.");
      const jobId = url.searchParams.get("jobId");
      if (jobId && !isUuid(jobId)) throw new HttpError(400, "jobId must be a job id.");
      const page = await store.listRuns(ctx.user.id, { limit, offset, status: (status as RunStatus) || undefined, jobId: jobId || undefined });
      return json({ ...page, limit, offset });
    },

    get: async (req: Request, ctx: Ctx) => json(await requireRun(ctx.user.id, idOf(req))),

    cancel: async (req: Request, ctx: Ctx) => {
      const run = await requireRun(ctx.user.id, idOf(req));
      if (isTerminal(run.status)) throw new HttpError(409, "This run has already finished.");
      if (!runs.cancel(run.id)) throw new HttpError(409, "This run is not active.");
      return json({ cancelling: true }, 202);
    },

    /** The whole log as JSON (history view and download): ?after=<id>&limit=<n>. */
    log: async (req: Request, ctx: Ctx) => {
      const id = idOf(req);
      await requireRun(ctx.user.id, id);
      const url = new URL(req.url);
      const events = await store.listEvents(id, afterOf(req, url), intParam(url, "limit", 1000, 1, 5000));
      return json({ events, nextAfter: events.at(-1)?.id ?? null });
    },

    /**
     * Server-Sent Events: replays stored events after Last-Event-ID / ?after=, then streams live ones
     * and ends with an `end` event once the run has finished. Closing the connection never affects the run.
     */
    events: async (req: Request, ctx: Ctx, server: { timeout(req: Request, seconds: number): void }) => {
      const id = idOf(req);
      // Authorise before anything else (before parsing Last-Event-ID, before any stream opens): another user's run is a plain 404.
      await requireRun(ctx.user.id, id);
      const url = new URL(req.url);
      let last = afterOf(req, url);
      server.timeout(req, 0);

      const enc = new TextEncoder();
      let closed = false;
      let unsubscribe = () => {};
      let wake: (() => void) | null = null;
      const queue: HubMessage[] = [];

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (text: string) => {
            if (!closed) controller.enqueue(enc.encode(text));
          };
          const close = () => {
            if (closed) return;
            closed = true;
            unsubscribe();
            wake?.();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          };
          req.signal.addEventListener("abort", close, { once: true });
          // Subscribe before replaying so nothing published in between is lost; ids de-duplicate.
          unsubscribe = hub.subscribe(id, (m) => {
            queue.push(m);
            wake?.();
          });
          const sendEvent = (e: { id: number }) => {
            if (e.id <= last) return;
            last = e.id;
            send(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
          };
          const replay = async () => {
            for (;;) {
              const page = await store.listEvents(id, last, EVENT_PAGE);
              page.forEach(sendEvent);
              if (page.length < EVENT_PAGE) return;
            }
          };

          void (async () => {
            try {
              send("retry: 3000\n: connected\n\n");
              await replay();
              let ended = isTerminal((await store.system.getRun(id))!.status);
              while (!closed) {
                while (queue.length) {
                  const m = queue.shift()!;
                  if (m.kind === "event") sendEvent(m.event);
                  else ended = true;
                }
                if (ended) break;
                await new Promise<void>((resolve) => {
                  const timer = setTimeout(() => {
                    wake = null;
                    send(": ping\n\n");
                    resolve();
                  }, heartbeatMs);
                  wake = () => {
                    clearTimeout(timer);
                    wake = null;
                    resolve();
                  };
                });
              }
              if (!closed) {
                await replay(); // anything persisted but not yet pushed
                send(`event: end\ndata: ${JSON.stringify({ status: (await store.system.getRun(id))!.status })}\n\n`);
              }
            } catch (err) {
              console.error("SSE stream failed", err);
            } finally {
              close();
            }
          })();
        },
        cancel() {
          closed = true;
          unsubscribe();
          wake?.();
        },
      });

      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
      });
    },
  };
}
