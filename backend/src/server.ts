/** HTTP server: JSON API under /api, the built frontend for everything else. */

import { join, normalize } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { createAuth, type AuthOptions } from "./auth/auth.ts";
import { json } from "./http.ts";
import { createJobRoutes, type JobRouteDeps } from "./jobs/routes.ts";
import { createRunRoutes, type RunRouteDeps } from "./runs/routes.ts";
import { createInstanceRoutes, type InstanceRouteDeps } from "./instances/routes.ts";

export type ServerDeps = {
  /** Interface to bind; Bun's default would be every interface. */
  hostname?: string;
  port: number;
  staticDir: string | null;
  db: { ping(): Promise<boolean> };
  auth: AuthOptions;
  instances: InstanceRouteDeps;
  jobs: JobRouteDeps;
  runs: RunRouteDeps;
};

export function createServer(deps: ServerDeps) {
  const auth = createAuth(deps.auth);
  const instances = createInstanceRoutes(deps.instances);
  const jobs = createJobRoutes(deps.jobs);
  const runs = createRunRoutes(deps.runs);
  const clientKey = (req: Request): string => server.requestIP(req)?.address ?? "unknown";
  // Every /api route except health and login goes through auth.protect (session + CSRF).
  const p = auth.protect;

  const server: Bun.Server<undefined> = Bun.serve({
    hostname: deps.hostname ?? "127.0.0.1",
    port: deps.port,
    routes: {
      "/api/health": {
        GET: async () => {
          const database = await deps.db.ping();
          return json({ status: database ? "ok" : "degraded", database, version: pkg.version }, database ? 200 : 503);
        },
      },
      "/api/auth/login": { POST: (req) => auth.login(req, clientKey(req)) },
      "/api/auth/logout": { POST: auth.logout },
      "/api/auth/me": { GET: auth.me },
      "/api/instances": { GET: p(instances.list), POST: p(instances.create) },
      "/api/instances/:id": { GET: p(instances.get), PATCH: p(instances.update), DELETE: p(instances.remove) },
      "/api/instances/:id/check": { POST: p(instances.check) },
      "/api/jobs": { GET: p(jobs.list), POST: p(jobs.create) },
      "/api/jobs/:id": { GET: p(jobs.get), PATCH: p(jobs.update), DELETE: p(jobs.remove) },
      "/api/jobs/:id/run": { POST: p(jobs.run) },
      "/api/jobs/:id/schedule": { GET: p(jobs.getSchedule), PUT: p(jobs.putSchedule), DELETE: p(jobs.deleteSchedule) },
      "/api/schedules": { GET: p(jobs.listSchedules) },
      "/api/runs": { GET: p(runs.list), POST: p(runs.start) },
      "/api/runs/:id": { GET: p(runs.get) },
      "/api/runs/:id/cancel": { POST: p(runs.cancel) },
      "/api/runs/:id/log": { GET: p(runs.log) },
      "/api/runs/:id/events": { GET: p((req) => runs.events(req, server)) },
      "/api/*": p(() => json({ message: "Not found" }, 404)),
    },
    fetch: (req) => serveStatic(deps.staticDir, new URL(req.url).pathname),
    error(err) {
      console.error(err);
      return json({ message: "Internal error" }, 500);
    },
  });
  return server;
}

/** Serves the built single-page app; unknown paths fall back to index.html. */
async function serveStatic(staticDir: string | null, pathname: string): Promise<Response> {
  if (!staticDir) return new Response("Frontend not built. In development, open the Vite dev server.", { status: 404 });
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(staticDir, safe));
  if (safe !== "/" && (await file.exists())) return new Response(file);
  return new Response(Bun.file(join(staticDir, "index.html")), { headers: { "content-type": "text/html" } });
}
