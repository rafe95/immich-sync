/** Persistence of registered instances. The encrypted key never leaves this layer except to the check path. */

import type { SQL } from "bun";

export type InstanceRecord = {
  id: string;
  ownerId: string;
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

/** Unscoped reads/writes for the run executor only: a run already belongs to an owner whose instances it validated. */
export type SystemInstanceAccess = {
  get(id: string): Promise<InstanceRecord | null>;
  getKeyEnc(id: string): Promise<Buffer | null>;
  saveCheck(id: string, result: unknown, at: Date): Promise<void>;
};

/** Request methods are scoped to an owner; another owner's instance behaves exactly like a missing one. */
export type InstanceStore = {
  list(ownerId: string): Promise<InstanceRecord[]>;
  get(ownerId: string, id: string): Promise<InstanceRecord | null>;
  /** Encrypted key, for the connection check only. */
  getKeyEnc(ownerId: string, id: string): Promise<Buffer | null>;
  /** Throws AliasTakenError when the owner already has this alias. */
  create(ownerId: string, input: NewInstance): Promise<InstanceRecord>;
  update(ownerId: string, id: string, patch: InstancePatch): Promise<InstanceRecord | null>;
  /** Throws InstanceInUseError when a job step references it. Returns false if not found. */
  delete(ownerId: string, id: string): Promise<boolean>;
  saveCheck(ownerId: string, id: string, result: unknown, at: Date): Promise<void>;
  system: SystemInstanceAccess;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

function toRecord(r: any): InstanceRecord {
  const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
  return {
    id: r.id,
    ownerId: r.owner_id,
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

const COLS = "id, owner_id, alias, api_url, note, is_default, last_check, last_checked_at, created_at, updated_at";

function pgCode(err: unknown): string | undefined {
  return (err as { errno?: string; code?: string })?.errno ?? (err as { code?: string })?.code;
}

export function pgInstanceStore(sql: SQL): InstanceStore {
  const getKey = async (id: string, ownerId?: string) => {
    const [r] = ownerId === undefined
      ? await sql`select api_key_enc from instances where id = ${id}`
      : await sql`select api_key_enc from instances where id = ${id} and owner_id = ${ownerId}`;
    return r ? Buffer.from(r.api_key_enc) : null;
  };
  return {
    async list(ownerId) {
      return (await sql.unsafe(`select ${COLS} from instances where owner_id = $1 order by alias`, [ownerId])).map(toRecord);
    },
    async get(ownerId, id) {
      const [r] = await sql.unsafe(`select ${COLS} from instances where id = $1 and owner_id = $2`, [id, ownerId]);
      return r ? toRecord(r) : null;
    },
    getKeyEnc: (ownerId, id) => getKey(id, ownerId),
    async create(ownerId, input) {
      try {
        return await sql.begin(async (tx) => {
          if (input.isDefault) await tx`update instances set is_default = false where owner_id = ${ownerId} and is_default`;
          const [r] = await tx.unsafe(
            `insert into instances (owner_id, alias, api_url, api_key_enc, note, is_default) values ($1, $2, $3, $4, $5, $6) returning ${COLS}`,
            [ownerId, input.alias, input.apiUrl, input.apiKeyEnc, input.note, input.isDefault],
          );
          return toRecord(r);
        });
      } catch (err) {
        if (pgCode(err) === "23505") throw new AliasTakenError();
        throw err;
      }
    },
    async update(ownerId, id, p) {
      try {
        return await sql.begin(async (tx) => {
          const [owned] = await tx`select id from instances where id = ${id} and owner_id = ${ownerId}`;
          if (!owned) return null;
          if (p.isDefault) await tx`update instances set is_default = false where owner_id = ${ownerId} and is_default and id <> ${id}`;
          const sets: string[] = [];
          const params: unknown[] = [id, ownerId];
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
            `update instances set ${[...sets, "updated_at = now()"].join(", ")} where id = $1 and owner_id = $2 returning ${COLS}`,
            params,
          );
          return r ? toRecord(r) : null;
        });
      } catch (err) {
        if (pgCode(err) === "23505") throw new AliasTakenError();
        throw err;
      }
    },
    async delete(ownerId, id) {
      try {
        const rows = await sql`delete from instances where id = ${id} and owner_id = ${ownerId} returning id`;
        return rows.length > 0;
      } catch (err) {
        if (pgCode(err) === "23503") throw new InstanceInUseError();
        throw err;
      }
    },
    async saveCheck(ownerId, id, result, at) {
      await sql`update instances set last_check = ${JSON.stringify(result)}::text::jsonb, last_checked_at = ${at} where id = ${id} and owner_id = ${ownerId}`;
    },
    system: {
      async get(id) {
        const [r] = await sql.unsafe(`select ${COLS} from instances where id = $1`, [id]);
        return r ? toRecord(r) : null;
      },
      getKeyEnc: (id) => getKey(id),
      async saveCheck(id, result, at) {
        await sql`update instances set last_check = ${JSON.stringify(result)}::text::jsonb, last_checked_at = ${at} where id = ${id}`;
      },
    },
  };
}

/** In-memory store for tests; `usedByJobs` simulates job_steps references; `eraseOwner` is the user-deletion eraser's hook. */
export function memoryInstanceStore(): InstanceStore & { keys: Map<string, Buffer>; usedByJobs: Set<string>; eraseOwner(ownerId: string): void } {
  const rows = new Map<string, InstanceRecord>();
  const keys = new Map<string, Buffer>();
  const usedByJobs = new Set<string>();
  const stamp = () => new Date().toISOString();
  const owned = (ownerId: string, id: string) => {
    const r = rows.get(id);
    return r && r.ownerId === ownerId ? r : undefined;
  };
  const clearDefault = (ownerId: string, except?: string) => {
    for (const r of rows.values()) if (r.ownerId === ownerId && r.id !== except) r.isDefault = false;
  };
  const aliasTaken = (ownerId: string, alias: string, except?: string) =>
    [...rows.values()].some((r) => r.ownerId === ownerId && r.alias === alias && r.id !== except);
  const saveCheck = (r: InstanceRecord | undefined, result: unknown, at: Date) => {
    if (r) {
      r.lastCheck = result;
      r.lastCheckedAt = at.toISOString();
    }
  };
  return {
    keys,
    usedByJobs,
    eraseOwner(ownerId) {
      for (const r of [...rows.values()]) {
        if (r.ownerId !== ownerId) continue;
        rows.delete(r.id);
        keys.delete(r.id);
        usedByJobs.delete(r.id);
      }
    },
    async list(ownerId) {
      return [...rows.values()].filter((r) => r.ownerId === ownerId).sort((a, b) => a.alias.localeCompare(b.alias)).map((r) => ({ ...r }));
    },
    async get(ownerId, id) {
      const r = owned(ownerId, id);
      return r ? { ...r } : null;
    },
    async getKeyEnc(ownerId, id) {
      return owned(ownerId, id) ? (keys.get(id) ?? null) : null;
    },
    async create(ownerId, i) {
      if (aliasTaken(ownerId, i.alias)) throw new AliasTakenError();
      if (i.isDefault) clearDefault(ownerId);
      const r: InstanceRecord = {
        id: crypto.randomUUID(), ownerId, alias: i.alias, apiUrl: i.apiUrl, note: i.note, isDefault: i.isDefault,
        lastCheck: null, lastCheckedAt: null, createdAt: stamp(), updatedAt: stamp(),
      };
      rows.set(r.id, r);
      keys.set(r.id, i.apiKeyEnc);
      return { ...r };
    },
    async update(ownerId, id, p) {
      const r = owned(ownerId, id);
      if (!r) return null;
      if (p.alias !== undefined && aliasTaken(ownerId, p.alias, id)) throw new AliasTakenError();
      if (p.isDefault) clearDefault(ownerId, id);
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
    async delete(ownerId, id) {
      if (!owned(ownerId, id)) return false;
      if (usedByJobs.has(id)) throw new InstanceInUseError();
      rows.delete(id);
      keys.delete(id);
      return true;
    },
    async saveCheck(ownerId, id, result, at) {
      saveCheck(owned(ownerId, id), result, at);
    },
    system: {
      async get(id) {
        const r = rows.get(id);
        return r ? { ...r } : null;
      },
      async getKeyEnc(id) {
        return keys.get(id) ?? null;
      },
      async saveCheck(id, result, at) {
        saveCheck(rows.get(id), result, at);
      },
    },
  };
}
