/**
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set (e.g. `bun run db:up`, then
 * TEST_DATABASE_URL=postgres://immich_sync:devpassword@localhost:55432/immich_sync bun test).
 * Uses a throwaway schema, so it never touches the app's own tables.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate } from "../src/db/migrate.ts";

const url = process.env.TEST_DATABASE_URL;
const schema = `test_${Date.now()}`;
const sql = url ? new SQL(`${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`) : null;

/** Bun SQL queries are lazy: they only run when awaited, so `expect(query).rejects` never runs them. */
async function fails(query: PromiseLike<unknown>): Promise<boolean> {
  try {
    await query;
    return false;
  } catch {
    return true;
  }
}

afterAll(async () => {
  if (!sql) return;
  await sql.unsafe(`drop schema if exists ${schema} cascade`);
  await sql.close();
});

describe.skipIf(!url)("migrations (PostgreSQL)", () => {
  test("apply once, then are a no-op", async () => {
    await sql!.unsafe(`create schema ${schema}`);
    expect(await migrate(sql!)).toEqual(["0001_init.sql", "0002_sessions.sql"]);
    expect(await migrate(sql!)).toEqual([]);
  });

  test("constraints from the spec hold", async () => {
    const [a] = await sql!`insert into instances (alias, api_url, api_key_enc, is_default)
                           values ('home', 'http://a/api', '\\x00', true) returning id`;
    const [b] = await sql!`insert into instances (alias, api_url, api_key_enc)
                           values ('cclab', 'http://b/api', '\\x00') returning id`;
    // only one default instance
    expect(await fails(sql!`update instances set is_default = true where id = ${b.id}`)).toBe(true);
    // alias rules
    expect(await fails(sql!`insert into instances (alias, api_url, api_key_enc) values ('../x', 'u', '\\x00')`)).toBe(true);
    // a step needs two different instances
    const [job] = await sql!`insert into jobs (name) values ('Nightly') returning id`;
    expect(
      await fails(sql!`insert into job_steps (job_id, position, operation, source_id, target_id)
                       values (${job.id}, 1, 'copy', ${a.id}, ${a.id})`),
    ).toBe(true);
    await sql!`insert into job_steps (job_id, position, operation, source_id, target_id)
               values (${job.id}, 1, 'copy', ${a.id}, ${b.id})`;
    // an instance used by a job cannot be deleted
    expect(await fails(sql!`delete from instances where id = ${b.id}`)).toBe(true);
  });
});
