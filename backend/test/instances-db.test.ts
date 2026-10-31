/** PostgreSQL-backed stores; runs only when TEST_DATABASE_URL is set. Uses a throwaway schema. */
import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { pgUserStore } from "../src/auth/users.ts";
import { pgSessionStore, hashToken } from "../src/auth/sessions.ts";
import { migrate } from "../src/db/migrate.ts";
import { decryptSecret, encryptSecret } from "../src/crypto.ts";
import { AliasTakenError, InstanceInUseError, pgInstanceStore } from "../src/instances/store.ts";
import { startFakeImmich } from "../../core/test/fake-immich.ts";
import { loggedIn, SECRET, startTestServer } from "./helpers.ts";

const url = process.env.TEST_DATABASE_URL;
const schema = `test_inst_${Date.now()}`;
const sql = url ? new SQL(`${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`) : null;

afterAll(async () => {
  if (!sql) return;
  await sql.unsafe(`drop schema if exists ${schema} cascade`);
  await sql.close();
});

describe.skipIf(!url)("sessions and instances (PostgreSQL)", () => {
  test("migrations create the sessions table", async () => {
    await sql!.unsafe(`create schema ${schema}`);
    expect(await migrate(sql!)).toEqual(["0001_init.sql", "0002_sessions.sql", "0003_skipped_runs.sql", "0004_users.sql", "0005_ownership.sql"]);
  });

  test("session store: create, get, expire, delete", async () => {
    const s = pgSessionStore(sql!);
    const now = new Date();
    const user = await pgUserStore(sql!).create("sessionuser", "hash", "user");
    await s.create(hashToken("a"), { csrfToken: "c1", expiresAt: new Date(now.getTime() + 60_000), userId: user.id });
    await s.create(hashToken("old"), { csrfToken: "c2", expiresAt: new Date(now.getTime() - 1000), userId: user.id });
    expect((await s.get(hashToken("a"), now))?.csrfToken).toBe("c1");
    expect(await s.get(hashToken("old"), now)).toBeNull();
    await s.purgeExpired(now);
    const [{ count }] = await sql!`select count(*)::int as count from sessions`;
    expect(count).toBe(1);
    await s.delete(hashToken("a"));
    expect(await s.get(hashToken("a"), now)).toBeNull();
    // deleting the user removes their sessions
    await s.create(hashToken("b"), { csrfToken: "c3", expiresAt: new Date(now.getTime() + 60_000), userId: user.id });
    await pgUserStore(sql!).delete(user.id);
    expect(await s.get(hashToken("b"), now)).toBeNull();
  });

  test("instance store: bytea round trip, alias conflict, single default, in-use delete, check jsonb", async () => {
    const store = pgInstanceStore(sql!);
    const enc = encryptSecret("KEY-A", SECRET);
    const a = await store.create({ alias: "a", apiUrl: "http://a/api", apiKeyEnc: enc, note: null, isDefault: true });
    expect(decryptSecret((await store.getKeyEnc(a.id))!, SECRET)).toBe("KEY-A");
    // aliases are unique per owner now (the store has no owner until the ownership work reaches it), so own 'a' via SQL
    const [owner] = await sql!`insert into users (username, role, password_hash) values ('alias-owner', 'admin', 'x') returning id`;
    await sql!`update instances set owner_id = ${owner.id} where id = ${a.id}`;
    let duplicateRejected = false;
    try {
      await sql!`insert into instances (alias, api_url, api_key_enc, owner_id) values ('a', 'http://x/api', ${enc}, ${owner.id})`;
    } catch {
      duplicateRejected = true;
    }
    expect(duplicateRejected).toBe(true);
    const b = await store.create({ alias: "b", apiUrl: "http://b/api", apiKeyEnc: enc, note: "n", isDefault: true });
    expect((await store.list()).filter((i) => i.isDefault).map((i) => i.alias)).toEqual(["b"]);
    await store.saveCheck(b.id, { ok: true }, new Date());
    expect((await store.get(b.id))?.lastCheck).toEqual({ ok: true });
    const upd = await store.update(b.id, { apiUrl: "http://b2/api" });
    expect(upd?.lastCheck).toBeNull();
    const [job] = await sql!`insert into jobs (name) values ('j') returning id`;
    await sql!`insert into job_steps (job_id, position, operation, source_id, target_id) values (${job.id}, 1, 'copy', ${a.id}, ${b.id})`;
    await expect(store.delete(b.id)).rejects.toBeInstanceOf(InstanceInUseError);
    await sql!`delete from jobs where id = ${job.id}`;
    expect(await store.delete(b.id)).toBe(true);
    expect(await store.delete(b.id)).toBe(false);
  });

  test("full API on PostgreSQL: create, check against the fake Immich, in-use 409", async () => {
    const fake = startFakeImmich();
    const store = pgInstanceStore(sql!);
    const t = startTestServer({ store, sessions: pgSessionStore(sql!), users: pgUserStore(sql!) });
    await t.ready;
    try {
      const { call } = await loggedIn(t.base);
      const created = await (await call("POST", "/api/instances", { alias: "fake", apiUrl: fake.url, apiKey: fake.apiKey })).json();
      const raw = await sql!`select api_key_enc from instances where id = ${created.id}`;
      expect(Buffer.from(raw[0].api_key_enc).includes(Buffer.from(fake.apiKey))).toBe(false);
      const check = await (await call("POST", `/api/instances/${created.id}/check`)).json();
      expect(check.ok).toBe(true);
      expect((await (await call("GET", `/api/instances/${created.id}`)).json()).lastCheck.ok).toBe(true);
      const other = await (await call("POST", "/api/instances", { alias: "other", apiUrl: fake.url, apiKey: "k" })).json();
      const [job] = await sql!`insert into jobs (name) values ('j2') returning id`;
      await sql!`insert into job_steps (job_id, position, operation, source_id, target_id) values (${job.id}, 1, 'copy', ${created.id}, ${other.id})`;
      expect((await call("DELETE", `/api/instances/${other.id}`)).status).toBe(409);
      await sql!`delete from jobs where id = ${job.id}`;
      expect((await call("DELETE", `/api/instances/${other.id}`)).status).toBe(200);
    } finally {
      await t.stop();
      fake.stop();
    }
  });
});
