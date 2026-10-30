import { ConfigError, loadConfig } from "./config.ts";
import { connectDb, migrate } from "./db/index.ts";
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

  const server = createServer({ port: config.port, staticDir: config.staticDir, db });
  console.log(`immich-sync listening on http://localhost:${server.port}`);

  const shutdown = async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
