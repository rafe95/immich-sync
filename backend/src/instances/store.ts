/** Persistence of registered instances. The encrypted key never leaves this layer except to the check path. */

import type { SQL } from "bun";

export type InstanceRecord = {
  id: string;
  alias: string;
  apiUrl: string;
  note: string | null;
  isDefault: boolean;
  lastCheck: unknown | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewInstance = { alias: string; apiUrl: string; apiKeyEnc: Buffer; note: string | null; isDefault: boolean };
export type InstancePatch = Partial<NewInstance>;

export class AliasTakenError extends Error {}
export class InstanceInUseError extends Error {}

export type InstanceStore = {
  list(): Promise<InstanceRecord[]>;
  get(id: string): Promise<InstanceRecord | null>;
  /** Encrypted key, for the connection check only. */
  getKeyEnc(id: string): Promise<Buffer | null>;
  create(input: NewInstance): Promise<InstanceRecord>;
  update(id: string, patch: InstancePatch): Promise<InstanceRecord | null>;
  /** Throws InstanceInUseError when a job step references it. Returns false if not found. */
  delete(id: string): Promise<boolean>;
  saveCheck(id: string, result: unknown, at: Date): Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

function toRecord(r: any): InstanceRecord {
  const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
  return {
    id: r.id,
    alias: r.alias,
    apiUrl: r.api_url,
    note: r.note,
    isDefault: r.is_default,
    lastCheck: r.last_check ?? null,
    lastCheckedAt: iso(r.last_checked_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

const COLS = "id, alias, api_url, note, is_default, last_check, last_checked_at, created_at, updated_at";

function pgCode(err: unknown): string | undefined {
  return (err as { errno?: string; code?: string })?.errno ?? (err as { code?: string })?.code;
}

export function pgInstanceStore(sql: SQL): InstanceStore {
  return {
    async list() {
      return (await sql.unsafe(`select ${COLS} from instances order by alias`)).map(toRecord);
    },
    async get(id) {
      const [r] = await sql.unsafe(`select ${COLS} from instances where id = $1`, [id]);
      return r ? toRecord(r) : null;
    },
    async getKeyEnc(id) {
      const [r] = await sql`select api_key_enc from instances where id = ${id}`;
      return r ? Buffer.from(r.api_key_enc) : null;
    },
    async create(input) {
      try {
        return await sql.begin(async (tx) => {
          if (input.isDefault) await tx`update instances set is_default = false where is_default`;
          const [r] = await tx.unsafe(
            `insert into instances (alias, api_url, api_key_enc, note, is_default) values ($1, $2, $3, $4, $5) returning ${COLS}`,
            [input.alias, input.apiUrl, input.apiKeyEnc, input.note, input.isDefault],
          );
          return toRecord(r);
        });
      } catch (err) {
        if (pgCode(err) === "23505") throw new AliasTakenError();
        throw err;
      }
    },
    async update(id, p) {
      try {
        return await sql.begin(async (tx) => {
          if (p.isDefault) await tx`update instances set is_default = false where is_default and id <> ${id}`;
          const sets: string[] = [];
          const params: unknown[] = [id];
          const set = (col: string, v: unknown) => {
            params.push(v);
            sets.push(`${col} = $${params.length}`);
          };
          if (p.alias !== undefined) set("alias", p.alias);
          if (p.apiUrl !== undefined) set("api_url", p.apiUrl);
          if (p.apiKeyEnc !== undefined) set("api_key_enc", p.apiKeyEnc);
          if (p.note !== undefined) set("note", p.note);
          if (p.isDefault !== undefined) set("is_default", p.isDefault);
          // A changed URL or key invalidates the previous check result.
          if (p.apiUrl !== undefined || p.apiKeyEnc !== undefined) sets.push("last_check = null", "last_checked_at = null");
          const [r] = await tx.unsafe(
            `update instances set ${[...sets, "updated_at = now()"].join(", ")} where id = $1 returning ${COLS}`,
            params,
          );
          return r ? toRecord(r) : null;
        });
      } catch (err) {
        if (pgCode(err) === "23505") throw new AliasTakenError();
        throw err;
      }
    },
    async delete(id) {
      try {
        const rows = await sql`delete from instances where id = ${id} returning id`;
        return rows.length > 0;
      } catch (err) {
        if (pgCode(err) === "23503") throw new InstanceInUseError();
        throw err;
      }
    },
    async saveCheck(id, result, at) {
      await sql`update instances set last_check = ${JSON.stringify(result)}::text::jsonb, last_checked_at = ${at} where id = ${id}`;
    },
  };
}

/** In-memory store for tests; `usedByJobs` simulates job_steps references. */
export function memoryInstanceStore(): InstanceStore & { keys: Map<string, Buffer>; usedByJobs: Set<string> } {
  const rows = new Map<string, InstanceRecord>();
  const keys = new Map<string, Buffer>();
  const usedByJobs = new Set<string>();
  const stamp = () => new Date().toISOString();
  const clearDefault = (except?: string) => {
    for (const r of rows.values()) if (r.id !== except) r.isDefault = false;
  };
  const aliasTaken = (alias: string, except?: string) => [...rows.values()].some((r) => r.alias === alias && r.id !== except);
  return {
    keys,
    usedByJobs,
    async list() {
      return [...rows.values()].sort((a, b) => a.alias.localeCompare(b.alias)).map((r) => ({ ...r }));
    },
    async get(id) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    async getKeyEnc(id) {
      return keys.get(id) ?? null;
    },
    async create(i) {
      if (aliasTaken(i.alias)) throw new AliasTakenError();
      if (i.isDefault) clearDefault();
      const r: InstanceRecord = {
        id: crypto.randomUUID(), alias: i.alias, apiUrl: i.apiUrl, note: i.note, isDefault: i.isDefault,
        lastCheck: null, lastCheckedAt: null, createdAt: stamp(), updatedAt: stamp(),
      };
      rows.set(r.id, r);
      keys.set(r.id, i.apiKeyEnc);
      return { ...r };
    },
    async update(id, p) {
      const r = rows.get(id);
      if (!r) return null;
      if (p.alias !== undefined && aliasTaken(p.alias, id)) throw new AliasTakenError();
      if (p.isDefault) clearDefault(id);
      if (p.alias !== undefined) r.alias = p.alias;
      if (p.apiUrl !== undefined) r.apiUrl = p.apiUrl;
      if (p.note !== undefined) r.note = p.note;
      if (p.isDefault !== undefined) r.isDefault = p.isDefault;
      if (p.apiKeyEnc !== undefined) keys.set(id, p.apiKeyEnc);
      if (p.apiUrl !== undefined || p.apiKeyEnc !== undefined) {
        r.lastCheck = null;
        r.lastCheckedAt = null;
      }
      r.updatedAt = stamp();
      return { ...r };
    },
    async delete(id) {
      if (!rows.has(id)) return false;
      if (usedByJobs.has(id)) throw new InstanceInUseError();
      rows.delete(id);
      keys.delete(id);
      return true;
    },
    async saveCheck(id, result, at) {
      const r = rows.get(id);
      if (r) {
        r.lastCheck = result;
        r.lastCheckedAt = at.toISOString();
      }
    },
  };
}
