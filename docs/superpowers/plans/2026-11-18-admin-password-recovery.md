# Admin Password Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A locked-out admin requests a one-time token from the login page, reads it from the backend log, and sets a new password with it.

**Architecture:** A pure, in-memory token store (`backend/src/auth/recovery.ts`) holds hashed, single-use 15-minute tokens per user. Two public, CSRF-exempt endpoints in `createAuth` use it, with their own request limiter and the shared login limiter for wrong tokens. `Login.svelte` gains a two-step "forgot admin password" view.

**Tech Stack:** Bun, TypeScript, `bun:test`, Svelte 5 runes, Skeleton/Tailwind.

**Spec:** `docs/superpowers/specs/2026-11-18-admin-password-recovery-design.md`

## Global Constraints

- Token: `newToken()` (32 bytes, base64url). Store only `hashToken(token)`. Lifetime 15 minutes (`RECOVERY_TTL_MS = 15 * 60_000`). Single use. Memory only, no migration.
- Only users with `role === "admin"` and no `deletingAt` get a token; every request answers `202 { "message": "If that is an administrator account, a reset token was written to the backend log." }`.
- A valid token is never replaced by a new request.
- The token appears only in one log line; never log passwords, never put the token in a response.
- Log lines, verbatim apart from the placeholders:
  - `[recovery] Password reset token for administrator "<username>": <token> (valid until <ISO time>)`
  - `[recovery] A reset token for "<username>" is already active until <ISO time>; use that one.`
  - `[recovery] Reset requested for "<username>": not an administrator, no token issued.`
  - `[recovery] Password for "<username>" was reset.`
- Usernames in log lines: `normalizeUsername`, control characters removed, at most 64 characters.
- Wrong/expired/used token: `400 { "message": "The reset token is invalid or has expired." }`; counts as a failure on the shared login limiter.
- Request limiter: separate `LoginRateLimiter` (defaults: 5 free, then exponential); every request calls `recordFailure`; throttled → `429` like `tooMany`, not logged.
- Password rules: `passwordProblem`. Success ends all the user's sessions and returns the same body/cookie as login (`startSession`).

## Review Focus

- Token pasted from a log viewer with surrounding spaces or a trailing newline → still accepted (trim). Test in Task 2.
- Username typed as ` Ada ` → treated as `ada`, same as login. Test in Task 2.
- Username containing `\n[recovery] Password reset token for administrator...` → cannot forge a log line. Test in Task 2.
- Two concurrent completes with the same token → exactly one succeeds (consume is synchronous before any await). Test in Task 1 (store) and Task 2.
- Admin demoted to user, or deletion started, between request and complete → token refused. Test in Task 2.

---

### Task 1: Recovery token store

**Files:**
- Create: `backend/src/auth/recovery.ts`
- Test: `backend/test/recovery-store.test.ts`

**Interfaces:**
- Produces:
  - `export const RECOVERY_TTL_MS = 15 * 60_000`
  - `export type RecoveryIssue = { issued: true; token: string; expiresAt: Date } | { issued: false; activeUntil: Date }`
  - `export type RecoveryTokens = { issue(userId: string): RecoveryIssue; consume(token: string): string | null; clear(userId: string): void }`
  - `export function createRecoveryTokens(o?: { now?: () => Date; ttlMs?: number }): RecoveryTokens`
  - `export function logSafeUsername(raw: string): string`

- [ ] **Step 1: Write the failing tests** (fake clock `let t = new Date("2026-11-18T10:00:00Z")`):
  - `issue then consume returns the userId once`: `consume(token)` → `"u1"`, second `consume(token)` → `null`.
  - `consume trims whitespace`: `consume(` ${token}\n`)` → `"u1"`.
  - `a second issue while active does not replace`: second `issue("u1")` → `{ issued: false, activeUntil: <first expiresAt> }`; first token still consumes.
  - `expiry`: advance `t` by `RECOVERY_TTL_MS`; `consume(token)` → `null`; `issue("u1")` → `issued: true` with a different token.
  - `clear(userId)` makes the token unusable.
  - `unknown or empty token` → `null`.
  - `logSafeUsername("Ada\n[recovery] x")` contains no `\n`/`\r` and is lowercase; `logSafeUsername("a".repeat(100)).length` → `64`.
- [ ] **Step 2: Run** `bun test backend/test/recovery-store.test.ts` — expected FAIL (module not found).
- [ ] **Step 3: Implement** in `recovery.ts`: `Map<userId, { hash: string; expiresAt: Date }>`; `consume` hashes the trimmed token, finds the entry, checks expiry, deletes it synchronously, returns the userId; sweep expired entries on every call. Reuse `newToken`/`hashToken` from `sessions.ts`, `normalizeUsername` from `users.ts`.
- [ ] **Step 4: Run** the same command — expected PASS.
- [ ] **Step 5: Commit** `git add backend/src/auth/recovery.ts backend/test/recovery-store.test.ts && git commit -m "Add in-memory admin recovery token store"`

### Task 2: Recovery endpoints

**Files:**
- Modify: `backend/src/auth/auth.ts` (options, two handlers, `changePassword` clears tokens, return them)
- Modify: `backend/src/server.ts:59-62` (routes)
- Modify: `backend/test/helpers.ts` (`startTestServer` accepts `recoveryLog?: (line: string) => void`, `recoveryLimiter?: LoginRateLimiter`, passes them through `auth`)
- Test: `backend/test/recovery.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - `AuthOptions` gains `recovery?: RecoveryTokens`, `recoveryLimiter?: LoginRateLimiter`, `log?: (line: string) => void` (default `console.log`).
  - `createAuth(...)` returns `requestRecovery(req: Request, clientKey: string): Promise<Response>` and `completeRecovery(req: Request, clientKey: string): Promise<Response>`.
  - Routes: `POST /api/auth/recovery` → `{ username }`; `POST /api/auth/recovery/complete` → `{ token, newPassword }`; both public, outside `protect`. Update the comment at `server.ts:43`.

- [ ] **Step 1: Write the failing tests** in `recovery.test.ts`, using `startTestServer({ recoveryLog: (l) => lines.push(l) })` and a helper `tokenFrom(lines)` that extracts the token with `/: (\S+) \(valid until /`:
  - `admin reset end to end`: request for `USERNAME` → 202 with the constant body, no `set-cookie`; one log line matching the token format; complete with `{ token, newPassword: "a brand new password" }` → 200, body `authenticated: true`, `set-cookie` present; login with the old `PASSWORD` → 401, with the new one → 200; a session created before the reset gets 401 on `/api/auth/me`; log has `Password for "<USERNAME>" was reset.`; the password does not appear in any log line.
  - `no CSRF or session needed`: both endpoints succeed with no cookie and no `x-csrf-token`.
  - `same response for non-admin and unknown users`: seed a `user`-role account; request for it and for `"nobody"` → both 202 with the identical body; log lines say `not an administrator, no token issued`; no token line.
  - `spam does not replace an active token`: two requests → second logs `already active until`; the first token still completes.
  - `token is single use`: second complete with the same token → 400 with the exact message.
  - `concurrent completes`: `Promise.all` of two completes with one token → statuses sorted `[200, 400]`.
  - `trimmed token and normalized username`: request with `"  " + USERNAME.toUpperCase() + " "` issues a token; complete with `token + "\n"` → 200.
  - `log injection`: request username `"x\n[recovery] Password reset token for administrator \"admin\": fake (valid until z)"` → exactly one log line, with no newline in it.
  - `wrong tokens back off`: with a `LoginRateLimiter({ freeAttempts: 2 })` as `limiter`, three wrong completes → the third is 429.
  - `request throttling`: with `recoveryLimiter: new LoginRateLimiter({ freeAttempts: 2 })`, the third request → 429 and adds no log line.
  - `weak new password` → 400 with `passwordProblem`'s message; the token is still usable afterwards (validate before consuming).
  - `demoted or deleting admin`: issue a token, then `users.update(id, { role: "user" })` (seed a second admin first) → complete 400; likewise after `users.markDeleting`.
  - `normal password change clears a pending token`: issue, then `POST /api/auth/password` as that admin → the token now gives 400.
- [ ] **Step 2: Run** `bun test backend/test/recovery.test.ts` — expected FAIL (404 on the routes).
- [ ] **Step 3: Implement** `requestRecovery`: limiter check → `readJsonObject` → `normalizeUsername` → `users.getCredentials` → issue/log per Global Constraints → constant 202. `completeRecovery`: shared limiter check → read body → `passwordProblem` (400, no consume) → `recovery.consume(token)` (null → `recordFailure` + 400) → `users.get`, must be admin and not deleting (else `recordFailure` + 400) → `hashPassword` → `writes.write(userId, stillActive, () => update hash, recovery.clear, sessions.deleteForUser, touchLogin, startSession)` like `changePassword` → `limiter.recordSuccess` → log reset line. In `changePassword`, call `recovery.clear(ctx.user.id)` after the hash update. Wire the routes.
- [ ] **Step 4: Run** `bun test backend/test/recovery.test.ts backend/test/auth.test.ts backend/test/server.test.ts` — expected PASS.
- [ ] **Step 5: Commit** `git add backend/src/auth/auth.ts backend/src/server.ts backend/test/helpers.ts backend/test/recovery.test.ts && git commit -m "Add public admin password recovery endpoints"`

### Task 3: Login screen recovery flow

**Files:**
- Modify: `frontend/src/lib/api.ts` (client methods)
- Modify: `frontend/src/lib/session.svelte.ts` (session helper)
- Modify: `frontend/src/Login.svelte`
- Test: `frontend/src/AccountScreens.test.ts` (new `describe("Admin password recovery")`)

**Interfaces:**
- Consumes: Task 2 routes and response bodies.
- Produces:
  - `api.requestRecovery(username: string): Promise<string>` (returns the server's message).
  - `api.completeRecovery(token: string, newPassword: string): Promise<SessionUser | null>` (stores the CSRF token like `login`).
  - `export async function completeRecovery(token: string, newPassword: string)` in `session.svelte.ts`, which sets `session.user`/`status` like `login`.

- [ ] **Step 1: Write the failing tests** with the existing fetch-stub pattern:
  - `forgot link shows the request step`: click "Forgot admin password?" → username field and "Send reset token" button visible; submitting calls `POST /api/auth/recovery`; the page then shows the server message and the text `docker compose logs app`, plus the token, new password and confirm fields.
  - `mismatched confirmation`: token + "a brand new password" + "a different password" → alert "The passwords do not match."; no `POST /api/auth/recovery/complete` in `calls`.
  - `successful reset signs in`: matching fields → one `POST /api/auth/recovery/complete`; `session.status === "authenticated"`.
  - `back to sign in` returns to the login form.
- [ ] **Step 2: Run** `bun test frontend/src/AccountScreens.test.ts` — expected FAIL.
- [ ] **Step 3: Implement**: a `view` state (`"login" | "request" | "reset"`) in `Login.svelte`. Same card styling and error alert pattern as the login form. Password inputs use `autocomplete="new-password"` and `minlength` set to `MIN_PASSWORD_LENGTH` (12). The reset step is reachable directly from the request step via "I already have a token".
- [ ] **Step 4: Run** `bun test frontend/src/AccountScreens.test.ts && bun run typecheck` — expected PASS.
- [ ] **Step 5: Commit** `git add frontend/src && git commit -m "Add admin password recovery to the login screen"`

### Task 4: Documentation and full verification

**Files:**
- Modify: `README.md` (replace the "Forgotten the only admin password?" paragraph at line 43)
- Modify: `AGENTS.md` (the auth summary in "Project status" and the "no keys in logs" invariant)

- [ ] **Step 1: README**: describe the flow (login page → "Forgot admin password?" → read `[recovery]` line via `docker compose logs app` or the NAS log viewer → token + new password). Mention the 15-minute single-use token, admins only, a restart drops pending tokens, and a reset signs out all of that admin's sessions. Keep the database-hash procedure only as a last resort, in one sentence.
- [ ] **Step 2: AGENTS.md**: add "log-delivered admin password recovery" to the auth summary. Extend the logging invariant: the recovery token is the one credential deliberately written to the log (single-use, 15 minutes, stored as a hash, never in responses).
- [ ] **Step 3: Run** `bun test && bun run typecheck` — expected all pass (database tests skipped unless `TEST_DATABASE_URL` is set).
- [ ] **Step 4: Commit** `git add README.md AGENTS.md && git commit -m "Document admin password recovery"`
