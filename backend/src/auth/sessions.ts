/** Server-side sessions: opaque random cookie token, only its hash is stored. */

import { createHash, randomBytes } from "node:crypto";
import type { SQL } from "bun";

export type Session = { csrfToken: string; expiresAt: Date };

export type SessionStore = {
  create(idHash: string, session: Session): Promise<void>;
  /** The session if it exists and has not expired. */
  get(idHash: string, now: Date): Promise<Session | null>;
  delete(idHash: string): Promise<void>;
  purgeExpired(now: Date): Promise<void>;
  /** Ends every session (used when the password changes). */
  deleteAll(): Promise<void>;
};

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const newToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function memorySessionStore(): SessionStore {
  const rows = new Map<string, Session>();
  return {
    async create(idHash, s) {
      rows.set(idHash, s);
    },
    async get(idHash, now) {
      const s = rows.get(idHash);
      return s && s.expiresAt > now ? s : null;
    },
    async delete(idHash) {
      rows.delete(idHash);
    },
    async purgeExpired(now) {
      for (const [k, s] of rows) if (s.expiresAt <= now) rows.delete(k);
    },
    async deleteAll() {
      rows.clear();
    },
  };
}

export function pgSessionStore(sql: SQL): SessionStore {
  return {
    async create(idHash, s) {
      await sql`insert into sessions (id_hash, csrf_token, expires_at) values (${idHash}, ${s.csrfToken}, ${s.expiresAt})`;
    },
    async get(idHash, now) {
      const [row] = await sql`select csrf_token, expires_at from sessions where id_hash = ${idHash} and expires_at > ${now}`;
      return row ? { csrfToken: row.csrf_token, expiresAt: new Date(row.expires_at) } : null;
    },
    async delete(idHash) {
      await sql`delete from sessions where id_hash = ${idHash}`;
    },
    async purgeExpired(now) {
      await sql`delete from sessions where expires_at <= ${now}`;
    },
    async deleteAll() {
      await sql`delete from sessions`;
    },
  };
}
