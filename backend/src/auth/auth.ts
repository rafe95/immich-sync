/**
 * Single-admin authentication: login/logout/me, the session cookie, and the one central
 * guard (`protect`) that enforces "session required" and CSRF for state-changing requests.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { SQL } from "bun";
import { errorResponse, HttpError, json, readJsonObject } from "../http.ts";
import { LoginRateLimiter } from "./rate-limit.ts";
import { hashToken, newToken, SESSION_TTL_MS, type Session, type SessionStore } from "./sessions.ts";

export const SESSION_COOKIE = "immich_sync_session";
export const CSRF_HEADER = "x-csrf-token";

/** Where the changed admin password hash lives. While none is stored, ADMIN_PASSWORD from the environment is the credential. */
export type PasswordStore = {
  getHash(): Promise<string | null>;
  setHash(hash: string): Promise<void>;
};

export const PASSWORD_SETTING_KEY = "admin_password_hash";
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export function memoryPasswordStore(): PasswordStore & { hash: string | null } {
  const store = {
    hash: null as string | null,
    async getHash() {
      return store.hash;
    },
    async setHash(h: string) {
      store.hash = h;
    },
  };
  return store;
}

export function pgPasswordStore(sql: SQL): PasswordStore {
  return {
    async getHash() {
      const [r] = await sql`select value from settings where key = ${PASSWORD_SETTING_KEY}`;
      if (!r) return null;
      const v = typeof r.value === "string" && r.value.startsWith('"') ? JSON.parse(r.value) : r.value;
      return typeof v === "string" && v ? v : null;
    },
    async setHash(hash) {
      await sql`insert into settings (key, value) values (${PASSWORD_SETTING_KEY}, ${JSON.stringify(hash)}::text::jsonb)
        on conflict (key) do update set value = excluded.value`;
    },
  };
}

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
  if (newPassword.length < MIN_PASSWORD_LENGTH) return `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (newPassword.length > MAX_PASSWORD_LENGTH) return `The new password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (newPassword === current) return "The new password must differ from the current one.";
  return null;
}

export type AuthOptions = {
  adminPassword: string;
  /** Stored password hash; takes precedence over adminPassword once set. Defaults to in-memory. */
  passwords?: PasswordStore;
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
  // Fail closed: an empty password would let anyone in.
  if (!options.adminPassword) throw new Error("ADMIN_PASSWORD is required.");
  const { sessions } = options;
  const limiter = options.limiter ?? new LoginRateLimiter();
  const now = options.now ?? (() => new Date());
  const passwords = options.passwords ?? memoryPasswordStore();
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
  function protect<R extends Request>(handler: (req: R, session: Session) => Response | Promise<Response>) {
    return async (req: R): Promise<Response> => {
      const session = await currentSession(req);
      if (!session) return json({ message: "Authentication required." }, 401);
      if (!SAFE_METHODS.has(req.method)) {
        const sent = req.headers.get(CSRF_HEADER);
        if (!sent || !safeEqual(sent, session.csrfToken)) return json({ message: "Invalid or missing CSRF token." }, 403);
      }
      try {
        return await handler(req, session);
      } catch (err) {
        if (err instanceof HttpError) return errorResponse(err);
        throw err;
      }
    };
  }

  /** Checks against the stored hash when there is one, otherwise the environment password. */
  async function passwordMatches(candidate: string): Promise<boolean> {
    const hash = await passwords.getHash();
    if (hash) {
      try {
        return await Bun.password.verify(candidate, hash);
      } catch {
        return false; // a corrupt stored hash fails closed
      }
    }
    return safeEqual(candidate, options.adminPassword);
  }

  async function startSession(req: Request, status = 200) {
    const t = now();
    await sessions.purgeExpired(t);
    const token = newToken();
    const session: Session = { csrfToken: newToken(), expiresAt: new Date(t.getTime() + SESSION_TTL_MS) };
    await sessions.create(hashToken(token), session);
    return json({ authenticated: true, csrfToken: session.csrfToken }, status, {
      "set-cookie": cookie(req, token, SESSION_TTL_MS / 1000),
    });
  }

  const login = async (req: Request, clientKey: string): Promise<Response> => {
    const wait = limiter.retryAfterSeconds(clientKey);
    if (wait > 0) {
      return json({ message: "Too many failed attempts. Try again later." }, 429, { "retry-after": String(wait) });
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err);
      throw err;
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (!password || !(await passwordMatches(password))) {
      limiter.recordFailure(clientKey);
      return json({ message: "Invalid password." }, 401);
    }
    limiter.recordSuccess(clientKey);
    return startSession(req);
  };

  /** Authenticated + CSRF (via protect). Same failure backoff as login, keyed by the client. */
  const changePassword = (clientKeyOf: (req: Request) => string) =>
    protect(async (req) => {
      const clientKey = clientKeyOf(req);
      const wait = limiter.retryAfterSeconds(clientKey);
      if (wait > 0) {
        return json({ message: "Too many failed attempts. Try again later." }, 429, { "retry-after": String(wait) });
      }
      const body = await readJsonObject(req);
      const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
      const next = typeof body.newPassword === "string" ? body.newPassword : "";
      if (!current || !(await passwordMatches(current))) {
        limiter.recordFailure(clientKey);
        return json({ message: "The current password is incorrect." }, 403);
      }
      limiter.recordSuccess(clientKey);
      const problem = newPasswordProblem(next, current);
      if (problem) throw new HttpError(400, problem);
      await passwords.setHash(await Bun.password.hash(next, { algorithm: "argon2id" }));
      // End every session, including this one, and hand back a fresh token and CSRF secret.
      await sessions.deleteAll();
      return startSession(req);
    });

  const logout = protect(async (req) => {
    await sessions.delete(hashToken(readCookie(req, SESSION_COOKIE)!));
    return json({ authenticated: false }, 200, { "set-cookie": cookie(req, "", 0) });
  });

  const me = protect((_req, session) => json({ authenticated: true, csrfToken: session.csrfToken }));

  return { protect, login, logout, me, changePassword };
}

export type Auth = ReturnType<typeof createAuth>;
