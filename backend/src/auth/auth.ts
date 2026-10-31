/**
 * Authentication: first-run setup, login/logout/me, the session cookie, and the one central
 * guard (`protect`) that enforces "session required" and CSRF for state-changing requests.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { errorResponse, HttpError, json, readJsonObject } from "../http.ts";
import { LoginRateLimiter } from "./rate-limit.ts";
import { memoryUserStore, passwordProblem, normalizeUsername, userView, usernameProblem, type User, type UserStore } from "./users.ts";
import { hashToken, newToken, SESSION_TTL_MS, type Session, type SessionStore } from "./sessions.ts";

export const SESSION_COOKIE = "immich_sync_session";
export const CSRF_HEADER = "x-csrf-token";

/**
 * Key for login backoff. Behind a reverse proxy every request has the proxy's socket address, so
 * only when the operator opts in (TRUST_PROXY=true) the first X-Forwarded-For hop is used.
 */
export function clientKeyFor(req: Request, socketAddress: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const hop = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (hop) return hop.slice(0, 64);
  }
  return socketAddress ?? "unknown";
}

/** Returns a problem message for an unacceptable new password, or null. */
export function newPasswordProblem(newPassword: string, current: string): string | null {
  const problem = passwordProblem(newPassword);
  if (problem) return problem.replace("The password", "The new password");
  if (newPassword === current) return "The new password must differ from the current one.";
  return null;
}

export const hashPassword = (password: string) => Bun.password.hash(password, { algorithm: "argon2id" });

/** The authenticated request context handed to protected handlers. */
export type AuthContext = Session & { user: User };

export type AuthOptions = {
  /** Defaults to an in-memory store (tests). */
  users?: UserStore;
  sessions: SessionStore;
  /** "auto": Secure when the request arrived over HTTPS (directly or via X-Forwarded-Proto). */
  secureCookies?: boolean | "auto";
  limiter?: LoginRateLimiter;
  now?: () => Date;
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

/** Constant-time string comparison (both sides hashed to equal length first). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function createAuth(options: AuthOptions) {
  const { sessions } = options;
  const limiter = options.limiter ?? new LoginRateLimiter();
  const now = options.now ?? (() => new Date());
  const users = options.users ?? memoryUserStore();
  // Verified for unknown usernames so a login attempt takes about as long either way.
  let dummyHash: Promise<string> | null = null;
  const secureMode = options.secureCookies ?? "auto";

  const isSecure = (req: Request) =>
    secureMode === "auto"
      ? new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https"
      : secureMode;

  const cookie = (req: Request, value: string, maxAgeSeconds: number) =>
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${isSecure(req) ? "; Secure" : ""}`;

  async function currentSession(req: Request): Promise<Session | null> {
    const token = readCookie(req, SESSION_COOKIE);
    return token ? sessions.get(hashToken(token), now()) : null;
  }

  /**
   * The central guard. Requires a valid session; for non-safe methods also requires the
   * session's CSRF token in the X-CSRF-Token header. Handlers only run when both hold.
   */
  function protect<R extends Request>(handler: (req: R, ctx: AuthContext) => Response | Promise<Response>) {
    return async (req: R): Promise<Response> => {
      const session = await currentSession(req);
      if (!session) return json({ message: "Authentication required." }, 401);
      if (!SAFE_METHODS.has(req.method)) {
        const sent = req.headers.get(CSRF_HEADER);
        if (!sent || !safeEqual(sent, session.csrfToken)) return json({ message: "Invalid or missing CSRF token." }, 403);
      }
      const user = await users.get(session.userId);
      if (!user) return json({ message: "Authentication required." }, 401);
      try {
        return await handler(req, { ...session, user });
      } catch (err) {
        if (err instanceof HttpError) return errorResponse(err);
        throw err;
      }
    };
  }

  /** Like protect, and the signed-in user must be an administrator. */
  function protectAdmin<R extends Request>(handler: (req: R, ctx: AuthContext) => Response | Promise<Response>) {
    return protect<R>((req, ctx) =>
      ctx.user.role === "admin" ? handler(req, ctx) : json({ message: "Administrator access required." }, 403),
    );
  }

  async function verify(password: string, hash: string): Promise<boolean> {
    try {
      return await Bun.password.verify(password, hash);
    } catch {
      return false; // a corrupt stored hash fails closed
    }
  }

  async function startSession(req: Request, user: User, status = 200) {
    const t = now();
    await sessions.purgeExpired(t);
    const token = newToken();
    const session: Session = { csrfToken: newToken(), expiresAt: new Date(t.getTime() + SESSION_TTL_MS), userId: user.id };
    await sessions.create(hashToken(token), session);
    return json({ authenticated: true, csrfToken: session.csrfToken, user: userView(user) }, status, {
      "set-cookie": cookie(req, token, SESSION_TTL_MS / 1000),
    });
  }

  const tooMany = (wait: number) => json({ message: "Too many failed attempts. Try again later." }, 429, { "retry-after": String(wait) });

  /** Public: tells the frontend whether to show the first-run setup. */
  const setupStatus = async () => json({ needsSetup: (await users.count()) === 0 });

  /**
   * Public and CSRF-exempt (there is no session yet). Works only while no user exists; the store
   * makes check-and-insert atomic, so concurrent requests can never both succeed.
   */
  const setup = async (req: Request, clientKey: string): Promise<Response> => {
    const wait = limiter.retryAfterSeconds(clientKey);
    if (wait > 0) return tooMany(wait);
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req);
      const problem = usernameProblem(body.username) ?? passwordProblem(body.password);
      if (problem) throw new HttpError(400, problem);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err);
      throw err;
    }
    // A closed setup reveals nothing to guess, so it never counts toward the shared login backoff (that would let
    // anyone lock everybody out of login from a shared address) and it is refused before any password hashing.
    const closed = () => json({ message: "Setup is already complete." }, 409);
    if ((await users.count()) > 0) return closed();
    const user = await users.createFirstAdmin(normalizeUsername(body.username as string), await hashPassword(body.password as string));
    if (!user) return closed();
    limiter.recordSuccess(clientKey);
    await users.touchLogin(user.id, now());
    return startSession(req, user, 201);
  };

  const login = async (req: Request, clientKey: string): Promise<Response> => {
    const wait = limiter.retryAfterSeconds(clientKey);
    if (wait > 0) return tooMany(wait);
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err);
      throw err;
    }
    if ((await users.count()) === 0) return json({ message: "No user exists yet. Complete the first-run setup.", needsSetup: true }, 409);
    const username = typeof body.username === "string" ? normalizeUsername(body.username) : "";
    const password = typeof body.password === "string" ? body.password : "";
    const found = username ? await users.getCredentials(username) : null;
    dummyHash ??= hashPassword("dummy password for unknown users");
    const ok = await verify(password || "-", found?.hash ?? (await dummyHash));
    if (!found || !password || !ok) {
      limiter.recordFailure(clientKey);
      return json({ message: "Invalid username or password." }, 401);
    }
    limiter.recordSuccess(clientKey);
    await users.touchLogin(found.user.id, now());
    return startSession(req, found.user);
  };

  /** Authenticated + CSRF (via protect). Changes the signed-in user's own password. Same failure backoff as login. */
  const changePassword = (clientKeyOf: (req: Request) => string) =>
    protect(async (req, ctx) => {
      const clientKey = clientKeyOf(req);
      const wait = limiter.retryAfterSeconds(clientKey);
      if (wait > 0) return tooMany(wait);
      const body = await readJsonObject(req);
      const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
      const next = typeof body.newPassword === "string" ? body.newPassword : "";
      const hash = await users.getHash(ctx.user.id);
      if (!current || !hash || !(await verify(current, hash))) {
        limiter.recordFailure(clientKey);
        return json({ message: "The current password is incorrect." }, 403);
      }
      limiter.recordSuccess(clientKey);
      const problem = newPasswordProblem(next, current);
      if (problem) throw new HttpError(400, problem);
      await users.update(ctx.user.id, { hash: await hashPassword(next) });
      // End all of this user's sessions, including this one, and hand back a fresh token and CSRF secret.
      await sessions.deleteForUser(ctx.user.id);
      return startSession(req, ctx.user);
    });

  const logout = protect(async (req) => {
    await sessions.delete(hashToken(readCookie(req, SESSION_COOKIE)!));
    return json({ authenticated: false }, 200, { "set-cookie": cookie(req, "", 0) });
  });

  const me = protect((_req, ctx) => json({ authenticated: true, csrfToken: ctx.csrfToken, user: userView(ctx.user) }));

  return { protect, protectAdmin, setup, setupStatus, login, logout, me, changePassword, users, sessions };
}

export type Auth = ReturnType<typeof createAuth>;
