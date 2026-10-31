/**
 * Single-admin authentication: login/logout/me, the session cookie, and the one central
 * guard (`protect`) that enforces "session required" and CSRF for state-changing requests.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { errorResponse, HttpError, json, readJsonObject } from "../http.ts";
import { LoginRateLimiter } from "./rate-limit.ts";
import { hashToken, newToken, SESSION_TTL_MS, type Session, type SessionStore } from "./sessions.ts";

export const SESSION_COOKIE = "immich_sync_session";
export const CSRF_HEADER = "x-csrf-token";

export type AuthOptions = {
  adminPassword: string;
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
    if (!password || !safeEqual(password, options.adminPassword)) {
      limiter.recordFailure(clientKey);
      return json({ message: "Invalid password." }, 401);
    }
    limiter.recordSuccess(clientKey);
    const t = now();
    await sessions.purgeExpired(t);
    const token = newToken();
    const session: Session = { csrfToken: newToken(), expiresAt: new Date(t.getTime() + SESSION_TTL_MS) };
    await sessions.create(hashToken(token), session);
    return json({ authenticated: true, csrfToken: session.csrfToken }, 200, {
      "set-cookie": cookie(req, token, SESSION_TTL_MS / 1000),
    });
  };

  const logout = protect(async (req) => {
    await sessions.delete(hashToken(readCookie(req, SESSION_COOKIE)!));
    return json({ authenticated: false }, 200, { "set-cookie": cookie(req, "", 0) });
  });

  const me = protect((_req, session) => json({ authenticated: true, csrfToken: session.csrfToken }));

  return { protect, login, logout, me };
}

export type Auth = ReturnType<typeof createAuth>;
