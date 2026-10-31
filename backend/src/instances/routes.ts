/** /api/instances handlers. Mounted behind the central auth/CSRF guard; they never see or return API keys. */

import { checkInstance, validateInstanceInput, type InstanceCheck } from "@immich-sync/core";
import { DecryptError, decryptSecret, encryptSecret } from "../crypto.ts";
import { HttpError, json, readJsonObject } from "../http.ts";
import { AliasTakenError, InstanceInUseError, isUuid, type InstancePatch, type InstanceStore } from "./store.ts";
import type { OwnerWriteContext } from "../auth/owner-writes.ts";

type Ctx = { user: { id: string } } & OwnerWriteContext;

export type InstanceRouteDeps = {
  store: InstanceStore;
  secretKey: string;
  /** Injectable for tests; defaults to the core check. */
  check?: typeof checkInstance;
};

function str(body: Record<string, unknown>, field: string): string | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string.`);
  return v;
}

function bool(body: Record<string, unknown>, field: string): boolean | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new HttpError(400, `${field} must be a boolean.`);
  return v;
}

function note(body: Record<string, unknown>): string | null | undefined {
  const v = body.note;
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, "note must be a string or null.");
  return v.trim() || null;
}

function validate(alias: string, apiUrl: string, apiKey: string) {
  const problems = validateInstanceInput({ alias, apiUrl, apiKey });
  if (problems.length) throw new HttpError(400, "Invalid instance.", { problems });
}

const normalizeUrl = (u: string) => u.trim().replace(/\/+$/, "");

export function createInstanceRoutes(deps: InstanceRouteDeps) {
  const { store, secretKey } = deps;
  const runCheck = deps.check ?? checkInstance;

  const idOf = (req: Request & { params?: Record<string, string> }) => {
    const id = req.params?.id ?? "";
    if (!isUuid(id)) throw new HttpError(404, "Instance not found.");
    return id;
  };
  const taken = () => new HttpError(409, "An instance with this alias already exists.");

  return {
    list: async (_req: Request, ctx: Ctx) => json({ instances: await store.list(ctx.user.id) }),

    get: async (req: Request, ctx: Ctx) => {
      const found = await store.get(ctx.user.id, idOf(req as never));
      if (!found) throw new HttpError(404, "Instance not found.");
      return json(found);
    },

    create: async (req: Request, ctx: Ctx) => {
      const body = await readJsonObject(req);
      const alias = str(body, "alias")?.trim() ?? "";
      const apiUrl = normalizeUrl(str(body, "apiUrl") ?? "");
      const apiKey = str(body, "apiKey")?.trim() ?? "";
      validate(alias, apiUrl, apiKey);
      try {
        const created = await ctx.write(() => store.create(ctx.user.id, {
          alias, apiUrl, apiKeyEnc: encryptSecret(apiKey, secretKey), note: note(body) ?? null, isDefault: bool(body, "isDefault") ?? false,
        }));
        return json(created, 201);
      } catch (err) {
        if (err instanceof AliasTakenError) throw taken();
        throw err;
      }
    },

    update: async (req: Request, ctx: Ctx) => {
      const id = idOf(req as never);
      const body = await readJsonObject(req);
      const current = await store.get(ctx.user.id, id);
      if (!current) throw new HttpError(404, "Instance not found.");
      const alias = str(body, "alias")?.trim();
      const apiUrl = str(body, "apiUrl") === undefined ? undefined : normalizeUrl(str(body, "apiUrl")!);
      const apiKey = str(body, "apiKey")?.trim();
      // An omitted key keeps the stored one; validate the rest with a placeholder key.
      validate(alias ?? current.alias, apiUrl ?? current.apiUrl, apiKey ?? "unchanged");
      const patch: InstancePatch = { alias, apiUrl, note: note(body), isDefault: bool(body, "isDefault") };
      if (apiKey !== undefined) patch.apiKeyEnc = encryptSecret(apiKey, secretKey);
      try {
        const updated = await ctx.write(() => store.update(ctx.user.id, id, patch));
        if (!updated) throw new HttpError(404, "Instance not found.");
        return json(updated);
      } catch (err) {
        if (err instanceof AliasTakenError) throw taken();
        throw err;
      }
    },

    remove: async (req: Request, ctx: Ctx) => {
      const id = idOf(req as never);
      try {
        if (!(await ctx.write(() => store.delete(ctx.user.id, id)))) throw new HttpError(404, "Instance not found.");
      } catch (err) {
        if (err instanceof InstanceInUseError) {
          throw new HttpError(409, "This instance is used by one or more job steps. Change or delete those jobs first.");
        }
        throw err;
      }
      return json({ deleted: true });
    },

    check: async (req: Request, ctx: Ctx) => {
      const id = idOf(req as never);
      const record = await store.get(ctx.user.id, id);
      const enc = await store.getKeyEnc(ctx.user.id, id);
      if (!record || !enc) throw new HttpError(404, "Instance not found.");
      let apiKey: string;
      try {
        apiKey = decryptSecret(enc, secretKey);
      } catch (err) {
        if (err instanceof DecryptError) {
          throw new HttpError(500, "The stored API key cannot be decrypted. Was SECRET_KEY changed? Re-enter the key.");
        }
        throw err;
      }
      const result: InstanceCheck = await runCheck({ alias: record.alias, apiUrl: record.apiUrl, apiKey });
      await ctx.write(() => store.saveCheck(ctx.user.id, id, result, new Date(result.checkedAt)));
      return json(result);
    },
  };
}
