/** /api/users: administrator-managed accounts. Wrapped in auth.protectAdmin by the server. */

import { hashPassword, type AuthContext } from "./auth.ts";
import { HttpError, json, readJsonObject } from "../http.ts";
import { isUuid } from "../instances/store.ts";
import type { SessionStore } from "./sessions.ts";
import type { createUserDeletion, UserDataEraser } from "./user-deletion.ts";
import { LastAdminError, normalizeUsername, passwordProblem, usernameProblem, UsernameTakenError, type Role, type UserStore } from "./users.ts";

export type UserRouteDeps = {
  users: UserStore;
  sessions: SessionStore;
  deletion: ReturnType<typeof createUserDeletion>;
  eraser: Pick<UserDataEraser, "counts">;
};

const parseRole = (v: unknown): Role => {
  if (v !== "admin" && v !== "user") throw new HttpError(400, "role must be 'admin' or 'user'.");
  return v;
};

// Queue before actor admission: reciprocal removals must not hold each other's deletion drains open.
const removals = new WeakMap<UserStore, Promise<void>>();

export function createUserRoutes({ users, sessions, deletion, eraser }: UserRouteDeps) {
  const idOf = (req: Request) => {
    const id = (req as Request & { params: { id: string } }).params.id;
    if (!isUuid(id)) throw new HttpError(404, "User not found.");
    return id;
  };
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      if (err instanceof UsernameTakenError || err instanceof LastAdminError) throw new HttpError(409, err.message);
      throw err;
    }
  };

  return {
    list: async () => json({ users: await users.list() }),

    create: async (req: Request, ctx: AuthContext) => {
      const body = await readJsonObject(req);
      const problem = usernameProblem(body.username) ?? passwordProblem(body.password);
      if (problem) throw new HttpError(400, problem);
      const role = body.role === undefined ? "user" : parseRole(body.role);
      const hash = await hashPassword(body.password as string);
      const user = await ctx.write(() => guard(() => users.create(normalizeUsername(body.username as string), hash, role)));
      return json({ user }, 201);
    },

    /** { role?, password? }. A password here is an administrator reset: it ends that user's sessions. */
    update: async (req: Request, ctx: AuthContext) => {
      const id = idOf(req);
      const body = await readJsonObject(req);
      if (body.role === undefined && body.password === undefined) throw new HttpError(400, "Provide role and/or password.");
      const patch: { role?: Role; hash?: string } = {};
      if (body.role !== undefined) patch.role = parseRole(body.role);
      if (body.password !== undefined) {
        const problem = passwordProblem(body.password);
        if (problem) throw new HttpError(400, problem);
        patch.hash = await hashPassword(body.password as string);
      }
      const user = await ctx.write(async () => {
        const updated = await guard(() => users.update(id, patch));
        if (!updated) throw new HttpError(404, "User not found.");
        if (patch.hash) await sessions.deleteForUser(id);
        return updated;
      });
      return json({ user });
    },

    /** What deleting the user would erase. */
    data: async (req: Request) => {
      const id = idOf(req);
      if (!(await users.get(id))) throw new HttpError(404, "User not found.");
      return json(await eraser.counts(id));
    },

    /** Cancels the user's runs, then erases their data; 409 (data kept, user locked out) when runs do not stop in time. */
    remove: async (req: Request, ctx: AuthContext) => {
      const id = idOf(req);
      const pending = (removals.get(users) ?? Promise.resolve()).then(() =>
        ctx.write(() => guard(() => deletion.remove(ctx.user.id, id))));
      const settled = pending.then(() => {}, () => {});
      removals.set(users, settled);
      const result = await pending.finally(() => {
        if (removals.get(users) === settled) removals.delete(users);
      });
      if (result === "not_found") throw new HttpError(404, "User not found.");
      if (result === "stopping") throw new HttpError(409, "Runs are still stopping. Try again.");
      return json({ deleted: true });
    },
  };
}
