/** HTTP server: JSON API under /api, the built frontend for everything else. */

import { join, normalize } from "node:path";
import pkg from "../package.json" with { type: "json" };

export type ServerDeps = {
  port: number;
  staticDir: string | null;
  db: { ping(): Promise<boolean> };
};

const json = (data: unknown, status = 200) => Response.json(data, { status });

export function createServer(deps: ServerDeps) {
  return Bun.serve({
    port: deps.port,
    routes: {
      "/api/health": {
        GET: async () => {
          const database = await deps.db.ping();
          return json({ status: database ? "ok" : "degraded", database, version: pkg.version }, database ? 200 : 503);
        },
      },
      "/api/*": () => json({ message: "Not found" }, 404),
    },
    fetch: (req) => serveStatic(deps.staticDir, new URL(req.url).pathname),
    error(err) {
      console.error(err);
      return json({ message: "Internal error" }, 500);
    },
  });
}

/** Serves the built single-page app; unknown paths fall back to index.html. */
async function serveStatic(staticDir: string | null, pathname: string): Promise<Response> {
  if (!staticDir) return new Response("Frontend not built. In development, open the Vite dev server.", { status: 404 });
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(staticDir, safe));
  if (safe !== "/" && (await file.exists())) return new Response(file);
  return new Response(Bun.file(join(staticDir, "index.html")), { headers: { "content-type": "text/html" } });
}
