# Admin password recovery (design)

## Intent

A self-hosted (NAS) operator who forgets the admin password must be able to get back in without
editing argon2id hashes in PostgreSQL (the current README procedure). The people resetting are NAS
admins: whoever can read the container log (Container Manager, Portainer, Unraid, `docker compose logs`).
Reading the log is the proof of authority; no console, env edit or restart is required.

Goals: simple flow from the login page; works with only a log viewer.
Non-goals: email/SMS recovery; recovery for regular users (an admin already resets those in Users,
`PATCH /api/users/:id`); distributed coordination across backend replicas.
Anti-goals: anyone without log access being able to reset, lock out, or enumerate accounts; the token
leaking anywhere other than the backend log.

## Approaches

- **A. Login-page request, token in the log (chosen).** Public request endpoint logs a one-time token;
  a form takes token + new password. Needs only a log viewer. Adds a public endpoint, mitigated below.
- B. `ADMIN_RECOVERY=true` env switch, token logged at startup. Nothing network-triggerable, but two env
  edits and restarts, and easy to leave on.
- C. CLI via `docker compose exec`. Smallest surface, but needs a NAS console, which the target operators
  may not have.

Chosen: A, by the user, because it matches the target operator and the safeguards cover the main risk
(token request spam).

## Design

**Backend** (`backend/src/auth/recovery.ts`, wired in `auth.ts` / `server.ts`):

- `POST /api/auth/recovery` `{ username }`: public, CSRF-exempt like login. Always answers `202` with the
  same body, whatever the username, so it never reveals whether an account exists or is an admin.
  - Admin, not deleting, and no valid token yet: create a 32-byte `newToken()`, keep only
    `hashToken(token)` with `expiresAt = now + 15 min` for that user, and log
    `[recovery] Password reset token for administrator "<username>": <token> (valid until <ISO time>)`.
  - Admin that already has a valid token: no new token (so spam can't invalidate the real one); log
    `[recovery] A reset token for "<username>" is already active until <time>; use that one.`
  - Unknown or non-admin username: log `[recovery] Reset requested for "<username>": not an administrator, no token issued.`
    The username is truncated to 64 characters and stripped of control characters before logging.
  - Throttled per client key with a separate `LoginRateLimiter` instance (every request counts), so the log
    can't be flooded. Throttled requests get `429` and are not logged.
- `POST /api/auth/recovery/complete` `{ token, newPassword }`: public, CSRF-exempt.
  - Uses the shared login limiter: the request is checked against the backoff first, and a wrong, expired
    or used token records a failure and returns `400 "The reset token is invalid or has expired."`.
  - The token is looked up by its hash. `passwordProblem(newPassword)` is enforced. The user must still be
    an admin and not deleting.
  - Inside the owner-write barrier (`writes.write`, as in `changePassword`): update the hash, delete that
    user's tokens and all their sessions, record success on the limiter, `touchLogin`, then `startSession`.
    The admin is signed in.
  - Logs `[recovery] Password for "<username>" was reset.` and never logs the token or password.
- Tokens are held in memory: single backend, one token per user, expired entries swept on access. A
  restart drops all tokens, which is acceptable (request a new one). No migration is needed.
- The token store and clock are injectable for tests; logging goes through an injectable `log`
  (default `console.log`), like `settings.ts`.

**Frontend** (`Login.svelte`, `lib/api.ts`):

- The login form gets a "Forgot admin password?" link, which opens a view with a username field and a
  "Send reset token" button. After the request it shows: "If that is an administrator account, a reset
  token was written to the backend log (e.g. `docker compose logs app`). It is valid for 15 minutes."
- A second step has the token, new password and confirm new password fields. A mismatched confirmation is
  rejected in the browser. On success the user is signed in as after a login. Also a "Back to sign in" link.

**Docs**: replace the README "Forgotten the only admin password?" paragraph. In AGENTS.md, note the
recovery token as the one deliberate credential in logs (single-use, 15 min, hash-only storage), so the
"no credentials in logs" rule stays accurate.

**Tests**:
- recovery unit tests (memory stores, fake clock): logged token works once; expiry; spam doesn't replace an
  active token; non-admin, unknown and deleting users get no token and the same response; wrong-token
  backoff; sessions ended; password rules; request throttling.
- A route test that both endpoints work without a session or CSRF.
- A `Login.svelte` component test for the two steps and the confirmation mismatch.

## Builder's calls

- The 15-minute lifetime and the request limiter settings (5 free requests, then exponential backoff).
- Whether a successful normal password change also clears a pending token. Suggested: yes, cheap to do.
- The exact UI copy and layout, following the existing Login/Setup styling.
