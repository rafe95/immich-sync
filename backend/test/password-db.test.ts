/** Password hash and session stores against PostgreSQL; runs only when TEST_DATABASE_URL is set. Uses a throwaway schema. */
import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createAuth, pgPasswordStore } from "../src/auth/auth.ts";
import { pgSessionStore } from "../src/auth/sessions.ts";
import { migrate } from "../src/db/migrate.ts";
import { PASSWORD } from "./helpers.ts";

const url = process.env.TEST_DATABASE_URL;
const schema = `test_pw_${Date.now()}`;
const sql = url ? new SQL(`${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`) : null;

afterAll(async () => {
  if (!sql) return;
  await sql.unsafe(`drop schema if exists ${schema} cascade`);
  await sql.close();
});

describe.skipIf(!url)("admin password (PostgreSQL)", () => {
  test("hash persists in settings; change ends all sessions; deleting the row restores ADMIN_PASSWORD", async () => {
    await sql!.unsafe(`create schema ${schema}`);
    await migrate(sql!);
    const passwords = pgPasswordStore(sql!);
    const sessions = pgSessionStore(sql!);
    const auth = createAuth({ adminPassword: PASSWORD, passwords, sessions });
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers });

    expect(await passwords.getHash()).toBeNull();
    const l1 = await auth.login(post("/api/auth/login", { password: PASSWORD }), "k");
    const c1 = l1.headers.get("set-cookie")!.split(";")[0]!;
    const csrf1 = ((await l1.json()) as { csrfToken: string }).csrfToken;
    const l2 = await auth.login(post("/api/auth/login", { password: PASSWORD }), "k");
    const c2 = l2.headers.get("set-cookie")!.split(";")[0]!;

    const NEW = "another long passphrase";
    const res = await auth.changePassword(() => "k")(post("/api/auth/password", { currentPassword: PASSWORD, newPassword: NEW }, { cookie: c1, "x-csrf-token": csrf1 }) as never);
    expect(res.status).toBe(200);
    const stored = await passwords.getHash();
    expect(stored).toStartWith("$argon2id$");
    const [row] = await sql!`select value from settings where key = 'admin_password_hash'`;
    expect(row).toBeTruthy();

    const me = (cookie: string) => auth.me(new Request("http://x/api/auth/me", { headers: { cookie } }) as never);
    expect((await me(c1)).status).toBe(401);
    expect((await me(c2)).status).toBe(401);
    expect((await me(res.headers.get("set-cookie")!.split(";")[0]!)).status).toBe(200);
    expect((await auth.login(post("/api/auth/login", { password: PASSWORD }), "k")).status).toBe(401);
    expect((await auth.login(post("/api/auth/login", { password: NEW }), "k")).status).toBe(200);

    // documented recovery: delete the row, the environment password works again
    await sql!`delete from settings where key = 'admin_password_hash'`;
    expect((await auth.login(post("/api/auth/login", { password: PASSWORD }), "k")).status).toBe(200);
    expect((await auth.login(post("/api/auth/login", { password: NEW }), "k")).status).toBe(401);
  });
});
