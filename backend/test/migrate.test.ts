/**
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set (e.g. `bun run db:up`, then
 * TEST_DATABASE_URL=postgres://immich_sync:devpassword@localhost:55432/immich_sync bun test).
 * Uses a throwaway schema, so it never touches the app's own tables.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(await migrate(sql!)).toEqual(["0001_init.sql", "0002_sessions.sql", "0003_skipped_runs.sql", "0004_users.sql", "0005_ownership.sql"]);
    expect(await migrate(sql!)).toEqual([]);
  });

  test("constraints from the spec hold", async () => {
    const [owner] = await sql!`insert into users (username, role, password_hash)
                               values ('constraint-owner', 'admin', 'x') returning id`;
    const [a] = await sql!`insert into instances (alias, api_url, api_key_enc, is_default, owner_id)
                           values ('home', 'http://a/api', '\\x00', true, ${owner.id}) returning id`;
    const [b] = await sql!`insert into instances (alias, api_url, api_key_enc, owner_id)
                           values ('cclab', 'http://b/api', '\\x00', ${owner.id}) returning id`;
    // only one default instance per owner
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

  test("alias is unique per owner", async () => {
    const [o1] = await sql!`insert into users (username, role, password_hash) values ('alias-one', 'user', 'x') returning id`;
    const [o2] = await sql!`insert into users (username, role, password_hash) values ('alias-two', 'user', 'x') returning id`;
    await sql!`insert into instances (alias, api_url, api_key_enc, owner_id) values ('shared', 'u', '\\x00', ${o1.id})`;
    await sql!`insert into instances (alias, api_url, api_key_enc, owner_id) values ('shared', 'u', '\\x00', ${o2.id})`;
    expect(
      await fails(sql!`insert into instances (alias, api_url, api_key_enc, owner_id) values ('shared', 'u', '\\x00', ${o1.id})`),
    ).toBe(true);
  });

  test("one default instance per owner", async () => {
    const [o1] = await sql!`insert into users (username, role, password_hash) values ('default-one', 'user', 'x') returning id`;
    const [o2] = await sql!`insert into users (username, role, password_hash) values ('default-two', 'user', 'x') returning id`;
    await sql!`insert into instances (alias, api_url, api_key_enc, owner_id, is_default) values ('d1', 'u', '\\x00', ${o1.id}, true)`;
    await sql!`insert into instances (alias, api_url, api_key_enc, owner_id, is_default) values ('d2', 'u', '\\x00', ${o2.id}, true)`;
    expect(
      await fails(sql!`insert into instances (alias, api_url, api_key_enc, owner_id, is_default) values ('d3', 'u', '\\x00', ${o1.id}, true)`),
    ).toBe(true);
  });
});

describe.skipIf(!url)("migration 0005 backfill (PostgreSQL)", () => {
  const extraSchemas: string[] = [];
  const tmpDirs: string[] = [];

  afterAll(async () => {
    for (const s of extraSchemas) await sql!.unsafe(`drop schema if exists ${s} cascade`);
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  });

  /** A fresh schema migrated only up to 0004, so the real 0005 backfill runs over seeded rows. */
  async function schemaAtMigration4(name: string): Promise<SQL> {
    await sql!.unsafe(`create schema ${name}`);
    extraSchemas.push(name);
    const dir = await mkdtemp(join(tmpdir(), "migrations-"));
    tmpDirs.push(dir);
    const real = join(import.meta.dir, "../src/db/migrations");
    for (const f of (await readdir(real)).filter((f) => /^000[1-4]_.+\.sql$/.test(f))) await copyFile(join(real, f), join(dir, f));
    const client = new SQL(`${url}${url!.includes("?") ? "&" : "?"}options=-c%20search_path%3D${name}`);
    await migrate(client, dir);
    return client;
  }

  async function seedRows(client: SQL) {
    await client`insert into instances (alias, api_url, api_key_enc) values ('old', 'u', '\\x00')`;
    await client`insert into jobs (name) values ('Old job')`;
    await client`insert into runs (job_name, trigger, started_by, settings) values ('Old job', 'manual', 'admin', '{}')`;
  }

  test("0005 assigns existing rows to the oldest admin", async () => {
    const client = await schemaAtMigration4(`${schema}_bf`);
    try {
      const [a1] = await client`insert into users (username, role, password_hash, created_at)
                                values ('admin-old', 'admin', 'x', now() - interval '2 days') returning id`;
      await client`insert into users (username, role, password_hash, created_at) values ('admin-new', 'admin', 'x', now() - interval '1 day')`;
      await client`insert into users (username, role, password_hash, created_at) values ('plain', 'user', 'x', now() - interval '3 days')`;
      await seedRows(client);
      expect(await migrate(client)).toEqual(["0005_ownership.sql"]);
      for (const table of ["instances", "jobs", "runs"]) {
        const rows = await client.unsafe(`select owner_id from ${table}`);
        expect(rows.map((r: { owner_id: string }) => r.owner_id)).toEqual([a1.id]);
      }
    } finally {
      await client.close();
    }
  });

  test("0005 leaves rows ownerless when there is no user", async () => {
    const client = await schemaAtMigration4(`${schema}_nu`);
    try {
      await seedRows(client);
      await migrate(client);
      for (const table of ["instances", "jobs", "runs"]) {
        const rows = await client.unsafe(`select owner_id from ${table}`);
        expect(rows.map((r: { owner_id: string | null }) => r.owner_id)).toEqual([null]);
      }
    } finally {
      await client.close();
    }
  });
});
