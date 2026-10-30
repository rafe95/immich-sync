/**
 * Plain-SQL migrations: every file in ./migrations named NNNN_description.sql runs once,
 * in name order, each inside its own transaction. Applied names are kept in schema_migrations.
 */

import type { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export async function migrate(sql: SQL, dir = MIGRATIONS_DIR): Promise<string[]> {
  await sql`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;
  const done = new Set((await sql`select name from schema_migrations`).map((r: { name: string }) => r.name));
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const text = await Bun.file(join(dir, file)).text();
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    applied.push(file);
  }
  return applied;
}
