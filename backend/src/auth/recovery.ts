/**
 * Admin password recovery tokens: single-use, short-lived, one per user, held in memory only.
 * A token is delivered through the backend log (the operator's proof of access) and only its hash is
 * kept. A restart drops pending tokens; that is fine, a new one can be requested.
 */

import { hashToken, newToken } from "./sessions.ts";
import { normalizeUsername } from "./users.ts";

export const RECOVERY_TTL_MS = 15 * 60_000;

export type RecoveryIssue = { issued: true; token: string; expiresAt: Date } | { issued: false; activeUntil: Date };

export type RecoveryTokens = {
  /** A new token, unless the user already has a valid one (which is never replaced). */
  issue(userId: string): RecoveryIssue;
  /** The token's user, removing the token; null when unknown, used or expired. Synchronous, so it is atomic. */
  consume(token: string): string | null;
  clear(userId: string): void;
};

export function createRecoveryTokens(o: { now?: () => Date; ttlMs?: number } = {}): RecoveryTokens {
  const now = o.now ?? (() => new Date());
  const ttl = o.ttlMs ?? RECOVERY_TTL_MS;
  const byUser = new Map<string, { hash: string; expiresAt: Date }>();

  const sweep = (t: Date) => {
    for (const [userId, entry] of byUser) if (entry.expiresAt <= t) byUser.delete(userId);
  };

  return {
    issue(userId) {
      const t = now();
      sweep(t);
      const active = byUser.get(userId);
      if (active) return { issued: false, activeUntil: active.expiresAt };
      const token = newToken();
      const expiresAt = new Date(t.getTime() + ttl);
      byUser.set(userId, { hash: hashToken(token), expiresAt });
      return { issued: true, token, expiresAt };
    },
    consume(token) {
      sweep(now());
      const trimmed = token.trim();
      if (!trimmed) return null;
      const hash = hashToken(trimmed);
      for (const [userId, entry] of byUser) {
        if (entry.hash === hash) {
          byUser.delete(userId);
          return userId;
        }
      }
      return null;
    },
    clear(userId) {
      byUser.delete(userId);
    },
  };
}

/**
 * A username fit for one log line: normalized, at most 64 characters, without control and format characters,
 * Unicode line/paragraph separators or double quotes (none of which a valid username contains).
 */
export function logSafeUsername(raw: string): string {
  return normalizeUsername(raw.replace(/[\p{Cc}\p{Cf}\u2028\u2029"]/gu, "")).slice(0, 64);
}
