import { ConfigError, loadConfig } from "./config.ts";
import { pgUserStore } from "./auth/users.ts";
import { pgSessionStore } from "./auth/sessions.ts";
import { pgInstanceStore } from "./instances/store.ts";
import { connectDb, migrate } from "./db/index.ts";
import { pgJobStore } from "./jobs/store.ts";
import { createCoreExecutor } from "./runs/executor.ts";
import { pgRunStore } from "./runs/store.ts";
import { createRetentionPruner } from "./settings.ts";
import { createJobRunServices } from "./services.ts";
import { createServer } from "./server.ts";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  const db = connectDb(config.databaseUrl);
  const applied = await migrate(db.sql);
  if (applied.length) console.log(`Database migrations applied: ${applied.join(", ")}`);

  const instanceStore = pgInstanceStore(db.sql);
  const runStore = pgRunStore(db.sql);
  const executor = createCoreExecutor({ instances: instanceStore.system, secretKey: config.secretKey });
  const userStore = pgUserStore(db.sql);
  const owners = { isDeleting: async (ownerId: string) => (await userStore.get(ownerId))?.deletingAt != null };
  const services = createJobRunServices({ instances: instanceStore, jobs: pgJobStore(db.sql), runs: runStore, executor, owners });
  const interrupted = await services.manager.recoverInterrupted();
  if (interrupted.length) console.log(`Marked ${interrupted.length} run(s) from the previous process as interrupted.`);
  const pruner = createRetentionPruner({ runs: runStore }); // prunes now, then daily

  const server = createServer({
    hostname: config.host,
    port: config.port,
    staticDir: config.staticDir,
    db,
    auth: { users: userStore, sessions: pgSessionStore(db.sql), secureCookies: config.cookieSecure },
    instances: { store: instanceStore, secretKey: config.secretKey },
    jobs: services.jobs,
    runs: services.runs,
    dashboard: services.dashboard,
    settings: services.settings,
    trustProxy: config.trustProxy,
  });
  await pruner.start();
  await services.scheduler.start();
  console.log(`immich-sync listening on http://${config.host}:${server.port}`);

  const shutdown = async () => {
    services.scheduler.stop();
    pruner.stop();
    services.manager.abortAll();
    await server.stop();
    await services.manager.whenIdle();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
