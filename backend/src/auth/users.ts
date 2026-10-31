/** User accounts: validation, and the stores (PostgreSQL and in-memory for tests). */

import type { SQL } from "bun";

export type Role = "admin" | "user";
export type User = {
  id: string;
  username: string;
  role: Role;
  createdAt: string;
  lastLoginAt: string | null;
  /** Set once the account's deletion has started: the user is locked out until the deletion completes. */
  deletingAt: string | null;
};
/** The part of a user that is returned from login/setup/me. */
export type UserView = Pick<User, "id" | "username" | "role">;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;

export class UsernameTakenError extends Error {
  constructor() {
    super("That username is already taken.");
    this.name = "UsernameTakenError";
  }
}
export class LastAdminError extends Error {
  constructor(message = "The last administrator cannot be deleted or demoted.") {
    super(message);
    this.name = "LastAdminError";
  }
}

export const userView = (u: User): UserView => ({ id: u.id, username: u.username, role: u.role });
export const normalizeUsername = (raw: string) => raw.trim().toLowerCase();

/** Problem message for an unacceptable username, or null. */
export function usernameProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || !USERNAME_PATTERN.test(raw.trim())) {
    return "The username must be 3 to 64 characters: letters, digits, dot, underscore or hyphen.";
  }
  return null;
}
/** Problem message for an unacceptable password, or null. */
export function passwordProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length < MIN_PASSWORD_LENGTH) return `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (raw.length > MAX_PASSWORD_LENGTH) return `The password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}

export type UserUpdate = { role?: Role; hash?: string };

export type UserStore = {
  count(): Promise<number>;
  /** Atomically creates the first admin; null when any user already exists. */
  createFirstAdmin(username: string, hash: string): Promise<User | null>;
  /** Throws UsernameTakenError on a duplicate (case-insensitive). */
  create(username: string, hash: string, role: Role): Promise<User>;
  get(id: string): Promise<User | null>;
  /** Looks up by (normalized) username, with the stored password hash. */
  getCredentials(username: string): Promise<{ user: User; hash: string } | null>;
  getHash(id: string): Promise<string | null>;
  list(): Promise<User[]>;
  /** Null when the user does not exist. Throws LastAdminError when it would demote the last admin. */
  update(id: string, patch: UserUpdate): Promise<User | null>;
  /** False when the user does not exist. Throws LastAdminError when it would delete the last admin. */
  delete(id: string): Promise<boolean>;
  touchLogin(id: string, at: Date): Promise<void>;
  /** Locks the user out (login and sessions) ahead of deleting them. Null when missing; throws LastAdminError under the same rule as `delete`. */
  markDeleting(id: string, at: Date): Promise<User | null>;
};

/** In-memory store for tests; `erase` is the user-deletion eraser's hook (removes the row without the last-admin rule). */
export function memoryUserStore(): UserStore & { erase(id: string): void } {
  type Row = User & { hash: string };
  const rows = new Map<string, Row>();
  const copy = ({ hash: _h, ...u }: Row): User => ({ ...u });
  const admins = () => [...rows.values()].filter((r) => r.role === "admin" && r.deletingAt === null).length;
  const byName = (name: string) => [...rows.values()].find((r) => r.username.toLowerCase() === name.toLowerCase());
  // No awaits between check and write below, so each operation is atomic on the single JS thread.
  const insert = (username: string, hash: string, role: Role): Row => {
    if (byName(username)) throw new UsernameTakenError();
    const row = { id: crypto.randomUUID(), username: username.toLowerCase(), role, hash, createdAt: new Date().toISOString(), lastLoginAt: null, deletingAt: null };
    rows.set(row.id, row);
    return row;
  };
  return {
    erase(id) {
      rows.delete(id);
    },
    async count() {
      return rows.size;
    },
    async createFirstAdmin(username, hash) {
      if (rows.size > 0) return null;
      return copy(insert(username, hash, "admin"));
    },
    async create(username, hash, role) {
      return copy(insert(username, hash, role));
    },
    async get(id) {
      const r = rows.get(id);
      return r ? copy(r) : null;
    },
    async getCredentials(username) {
      const r = byName(username);
      return r ? { user: copy(r), hash: r.hash } : null;
    },
    async getHash(id) {
      return rows.get(id)?.hash ?? null;
    },
    async list() {
      return [...rows.values()].sort((a, b) => a.username.localeCompare(b.username)).map(copy);
    },
    async update(id, patch) {
      const r = rows.get(id);
      if (!r) return null;
      if (patch.role && patch.role !== "admin" && r.role === "admin" && r.deletingAt === null && admins() <= 1) throw new LastAdminError();
      if (patch.role) r.role = patch.role;
      if (patch.hash) r.hash = patch.hash;
      return copy(r);
    },
    async delete(id) {
      const r = rows.get(id);
      if (!r) return false;
      if (r.role === "admin" && r.deletingAt === null && admins() <= 1) throw new LastAdminError();
      rows.delete(id);
      return true;
    },
    async touchLogin(id, at) {
      const r = rows.get(id);
      if (r) r.lastLoginAt = at.toISOString();
    },
    async markDeleting(id, at) {
      const r = rows.get(id);
      if (!r) return null;
      if (r.role === "admin" && r.deletingAt === null && admins() <= 1) throw new LastAdminError();
      r.deletingAt = at.toISOString();
      return copy(r);
    },
  };
}

function pgCode(err: unknown): string | undefined {
  return (err as { errno?: string; code?: string })?.errno ?? (err as { code?: string })?.code;
}

/** Serializes every operation that creates the first user or could remove the last admin. */
const USERS_LOCK = 7_355_608;

const COLS = "id, username, role, created_at, last_login_at, deleting_at";
const toUser = (r: any): User => ({
  id: r.id,
  username: r.username,
  role: r.role,
  createdAt: new Date(r.created_at).toISOString(),
  lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
  deletingAt: r.deleting_at ? new Date(r.deleting_at).toISOString() : null,
});

export function pgUserStore(sql: SQL): UserStore {
  return {
    async count() {
      const [r] = await sql`select count(*)::int as n from users`;
      return r.n;
    },
    async createFirstAdmin(username, hash) {
      try {
        return await sql.begin(async (tx) => {
          await tx.unsafe(`select pg_advisory_xact_lock(${USERS_LOCK})`);
          const [{ n }] = await tx.unsafe(`select count(*)::int as n from users`);
          if (n > 0) return null;
          const [r] = await tx.unsafe(`insert into users (username, role, password_hash) values ($1, 'admin', $2) returning ${COLS}`, [username.toLowerCase(), hash]);
          await tx.unsafe(`update instances set owner_id = $1 where owner_id is null`, [r.id]);
          await tx.unsafe(`update jobs set owner_id = $1 where owner_id is null`, [r.id]);
          await tx.unsafe(`update runs set owner_id = $1 where owner_id is null`, [r.id]);
          return toUser(r);
        });
      } catch (err) {
        if (pgCode(err) === "23505") throw new UsernameTakenError();
        throw err;
      }
    },
    async create(username, hash, role) {
      try {
        const [r] = await sql.unsafe(`insert into users (username, role, password_hash) values ($1, $2, $3) returning ${COLS}`, [username.toLowerCase(), role, hash]);
        return toUser(r);
      } catch (err) {
        if (pgCode(err) === "23505") throw new UsernameTakenError();
        throw err;
      }
    },
    async get(id) {
      const [r] = await sql.unsafe(`select ${COLS} from users where id = $1`, [id]);
      return r ? toUser(r) : null;
    },
    async getCredentials(username) {
      const [r] = await sql.unsafe(`select ${COLS}, password_hash from users where lower(username) = $1`, [username.toLowerCase()]);
      return r ? { user: toUser(r), hash: r.password_hash } : null;
    },
    async getHash(id) {
      const [r] = await sql.unsafe(`select password_hash from users where id = $1`, [id]);
      return r?.password_hash ?? null;
    },
    async list() {
      return (await sql.unsafe(`select ${COLS} from users order by lower(username)`)).map(toUser);
    },
    async update(id, patch) {
      return sql.begin(async (tx) => {
        await tx.unsafe(`select pg_advisory_xact_lock(${USERS_LOCK})`);
        const [cur] = await tx.unsafe(`select ${COLS} from users where id = $1 for update`, [id]);
        if (!cur) return null;
        if (patch.role && patch.role !== "admin" && cur.role === "admin" && cur.deleting_at === null) {
          const [{ n }] = await tx.unsafe(`select count(*)::int as n from users where role = 'admin' and deleting_at is null`);
          if (n <= 1) throw new LastAdminError();
        }
        const [r] = await tx.unsafe(
          `update users set role = coalesce($2, role), password_hash = coalesce($3, password_hash) where id = $1 returning ${COLS}`,
          [id, patch.role ?? null, patch.hash ?? null],
        );
        return toUser(r);
      });
    },
    async delete(id) {
      return sql.begin(async (tx) => {
        await tx.unsafe(`select pg_advisory_xact_lock(${USERS_LOCK})`);
        const [cur] = await tx.unsafe(`select role, deleting_at from users where id = $1 for update`, [id]);
        if (!cur) return false;
        if (cur.role === "admin" && cur.deleting_at === null) {
          const [{ n }] = await tx.unsafe(`select count(*)::int as n from users where role = 'admin' and deleting_at is null`);
          if (n <= 1) throw new LastAdminError();
        }
        await tx.unsafe(`delete from users where id = $1`, [id]); // sessions go with it (on delete cascade)
        return true;
      });
    },
    async touchLogin(id, at) {
      await sql.unsafe(`update users set last_login_at = $2 where id = $1`, [id, at]);
    },
    async markDeleting(id, at) {
      return sql.begin(async (tx) => {
        await tx.unsafe(`select pg_advisory_xact_lock(${USERS_LOCK})`);
        const [cur] = await tx.unsafe(`select role, deleting_at from users where id = $1 for update`, [id]);
        if (!cur) return null;
        if (cur.role === "admin" && cur.deleting_at === null) {
          const [{ n }] = await tx.unsafe(`select count(*)::int as n from users where role = 'admin' and deleting_at is null`);
          if (n <= 1) throw new LastAdminError();
        }
        const [r] = await tx.unsafe(`update users set deleting_at = $2 where id = $1 returning ${COLS}`, [id, at]);
        return toUser(r);
      });
    },
  };
}
