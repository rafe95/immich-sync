# Per-user Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every instance, job, schedule and run belongs to one user; request paths only see the caller's data; deleting a user cancels their runs and erases their data.

**Architecture:** Migration `0005_ownership.sql` adds `owner_id` to `instances`, `jobs`, `runs` and `deleting_at` to `users`. Request-path store methods take `ownerId: string` as their first parameter, so a forgotten filter is a type error; cross-user callers (scheduler, recovery, pruning, executor, user deletion) use an explicitly named `system` sub-object on each store. A new user-deletion service orchestrates lockout → cancel → bounded wait → erase.

**Tech Stack:** Bun, TypeScript, PostgreSQL via `Bun.sql`, `bun:test`; frontend Svelte 5 + Skeleton (Users screen only).

**Spec:** `docs/superpowers/specs/2026-10-31-per-user-ownership-design.md`

## Global Constraints

- New migration only: `backend/src/db/migrations/0005_ownership.sql`; never edit 0001–0004.
- Another user's object answers **404**, same body as a missing one.
- Admins are scoped like everyone else; admin-only stays: `/api/users*`, `/api/settings/retention`. Retention pruning stays global.
- Write locks stay keyed by instance id (no change to `runs/locks.ts`).
- Cancellation goes only through the run manager's existing `AbortController` path (never trashes unverified assets).
- Delete-user wait timeout default `60_000` ms, injectable for tests; on timeout answer **409** with message `"Runs are still stopping. Try again."`.
- DB tests gated by `TEST_DATABASE_URL`; API tests use memory stores via `test/helpers.ts`.
- Docs describe only implemented behaviour.

## Review Focus

1. **SSE/log/cancel on another user's run id** — must 404 before any event is streamed (`events`, `log`, `cancel` all call the scoped `getRun` first). Test in Task 4.
2. **Editing a job to swap in another user's instance id** (PATCH, not only POST) — 400 with `problems`. Test in Task 3.
3. **Schedule firing for a job whose owner is mid-deletion** — run must not start; scheduler records nothing and logs. Test in Task 5.
4. **Default-instance toggle per owner** — setting bob's default must not clear alice's. Test in Task 3 (memory) and Task 1 (DB index).
5. **Deleting a user while their run is queued behind another user's lock** — queued run is cancelled and erased; the other user's run continues untouched. Test in Task 6.

---

### Task 1: Migration 0005

**Files:**
- Create: `backend/src/db/migrations/0005_ownership.sql`
- Test: `backend/test/migrate.test.ts` (extend; DB-gated)

**Interfaces:**
- Produces columns: `instances.owner_id uuid null references users(id)`, `jobs.owner_id` (same), `runs.owner_id` (same), `users.deleting_at timestamptz null`; indexes `instances_owner_id`, `jobs_owner_id`, `runs_owner_id`; `unique (owner_id, alias)` on instances (drop the old `alias` unique constraint); `instances_single_default` replaced by `create unique index instances_single_default_per_owner on instances (owner_id) where is_default`.
- Backfill: `update <table> set owner_id = (select id from users where role = 'admin' order by created_at limit 1) where owner_id is null` for all three tables (a no-op when no admin exists).
- FKs have **no** `on delete` action (erasure deletes explicitly, Task 6).

- [ ] **Step 1: Write failing DB tests** in `migrate.test.ts`:
  - `0005 assigns existing rows to the oldest admin`: seed two admins (older `a1`), an instance, a job, a run before applying 0005 (apply migrations up to 0004 via the existing helper pattern, or insert after full migrate with `owner_id = null` then re-run the backfill statement — pick whichever the file's current structure supports); expect all three `owner_id = a1`.
  - `0005 leaves rows ownerless when there is no user`.
  - `alias is unique per owner`: same alias for two owners succeeds; twice for one owner `fails(...)` is true.
  - `one default per owner`: two owners each with `is_default = true` succeeds; second default for same owner fails.
- [ ] **Step 2: Run** `TEST_DATABASE_URL=postgres://immich_sync:devpassword@localhost:55432/immich_sync bun test test/migrate.test.ts` — expect FAIL (column missing).
- [ ] **Step 3: Write `0005_ownership.sql`** as specified above.
- [ ] **Step 4: Run** same command — expect PASS; run `bun test` without the env var — DB tests skipped, rest PASS.
- [ ] **Step 5: Commit** `git add backend/src/db/migrations/0005_ownership.sql backend/test/migrate.test.ts && git commit -m "Add ownership columns and per-owner alias/default constraints"`

### Task 2: Jobs are owned; run start carries the owner

**Files:**
- Modify: `backend/src/jobs/store.ts`, `backend/src/jobs/routes.ts`, `backend/src/runs/manager.ts`, `backend/src/scheduler.ts`, `backend/src/services.ts`, `backend/src/dashboard.ts`
- Modify: `backend/test/helpers.ts` (expose `adminId`)
- Test: `backend/test/jobs-runs-api.test.ts`, `backend/test/scheduler.test.ts`, `backend/test/jobs-runs-db.test.ts`

**Interfaces:**
- Consumes: Task 1 columns.
- Produces:
  - `JobRecord` gains `ownerId: string`.
  - `JobStore` request methods: `list(ownerId)`, `get(ownerId, id)`, `create(ownerId, input)`, `update(ownerId, id, patch)`, `delete(ownerId, id)`, `upsertSchedule(ownerId, jobId, s)`, `deleteSchedule(ownerId, jobId)`, `listSchedules(ownerId)`, `revokeMoveConfirmation(ownerId, jobId)`.
  - `JobStore.system`: `{ get(id): Promise<JobRecord | null>; listSchedules(): Promise<ScheduleRecord[]>; disableSchedules(ownerId: string): Promise<void> }`.
  - `StartRequest` gains `ownerId: string`; `RunManager.recordSkipped(jobId, reason)` resolves the job via `jobs.system.get`.
  - Scheduler uses `jobs.system.get` / `jobs.system.listSchedules` and starts runs with `ownerId: job.ownerId`.
  - `startTestServer` returns `adminId: string` (the seeded admin's id).
- Memory store keeps `ownerId` on each row; owner mismatch behaves as not found.

- [ ] **Step 1: Write failing tests:**
  - API `jobs are private to their owner`: admin creates a job; bob (`seedUser` + `loggedIn`) gets `GET /api/jobs` → `[]`; `GET|PATCH|DELETE /api/jobs/:id`, `POST /api/jobs/:id/run`, `GET|PUT|DELETE /api/jobs/:id/schedule` → 404 each; `GET /api/schedules` → `[]`.
  - Scheduler `scheduled run carries the job owner`: fire a schedule with fake timers; the started run request has `ownerId` equal to the job's owner.
  - DB `job store filters by owner` (gated): `get(other, id)` is null, `list(other)` empty, `system.get(id)` returns it.
- [ ] **Step 2: Run** `bun test test/jobs-runs-api.test.ts test/scheduler.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the signatures above; routes pass `ctx.user.id`; `snapshot()` uses `deps.jobs.get(req.ownerId, req.job.id)`; `services.ts` `lastScheduledRunAt` unchanged for now (Task 4 scopes it). Update every existing test call site (`t.store`/job store direct calls) to pass `t.adminId`.
- [ ] **Step 4: Run** `bun test` and `bun run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `git commit -am "Scope jobs and schedules to their owner"`

### Task 3: Instances are owned; jobs may only use the owner's instances

**Files:**
- Modify: `backend/src/instances/store.ts`, `backend/src/instances/routes.ts`, `backend/src/jobs/routes.ts`, `backend/src/runs/manager.ts`, `backend/src/runs/executor.ts`, `backend/src/services.ts`, `backend/src/dashboard.ts`
- Test: `backend/test/instances.test.ts`, `backend/test/instances-db.test.ts`, `backend/test/jobs-runs-api.test.ts`, `backend/test/executor.test.ts`

**Interfaces:**
- Consumes: `StartRequest.ownerId` (Task 2).
- Produces:
  - `InstanceRecord` gains `ownerId: string`.
  - `InstanceStore` request methods: `list(ownerId)`, `get(ownerId, id)`, `getKeyEnc(ownerId, id)`, `create(ownerId, input)`, `update(ownerId, id, patch)`, `delete(ownerId, id)`, `saveCheck(ownerId, id, result, at)`.
  - `InstanceStore.system`: `{ get(id); getKeyEnc(id); saveCheck(id, result, at) }` — used only by `runs/executor.ts`.
  - "Default" clearing in `create`/`update` is `where owner_id = $owner and is_default`.
  - `AliasTakenError` now means "taken for this owner".
- Job create/update validation: instances resolved with `instances.list(ctx.user.id)`; unknown ids produce the existing `checkStepInstances` problems → 400.
- `snapshot()` resolves `deps.instances.list(req.ownerId)`.

- [ ] **Step 1: Write failing tests:**
  - API `instances are private to their owner`: bob sees `[]`; `GET|PATCH|DELETE /api/instances/:id`, `POST /api/instances/:id/check` → 404.
  - API `two users may share an alias and each have a default`: both create `home` with `isDefault: true` → 201 each; admin's `GET /api/instances` still shows its `home` as default.
  - API `job cannot use another user's instance`: bob POSTs a job with admin's instance ids → 400 with `problems`; bob PATCHes his own job's steps to admin's ids → 400; bob POSTs `/api/runs` ad-hoc with admin's ids → 400.
  - Executor test still passes using `instances.system`.
- [ ] **Step 2: Run** `bun test test/instances.test.ts test/jobs-runs-api.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the signatures; routes pass `ctx.user.id`; update test call sites.
- [ ] **Step 4: Run** `bun test`, `bun run typecheck`, and DB tests with `TEST_DATABASE_URL` — expect PASS.
- [ ] **Step 5: Commit** `git commit -am "Scope instances to their owner and check job instance ownership"`

### Task 4: Runs, events and dashboard are owned

**Files:**
- Modify: `backend/src/runs/store.ts`, `backend/src/runs/manager.ts`, `backend/src/runs/routes.ts`, `backend/src/dashboard.ts`, `backend/src/services.ts`, `backend/src/settings.ts` (unchanged API, verify)
- Test: `backend/test/jobs-runs-api.test.ts`, `backend/test/dashboard-skipped-retention.test.ts`, `backend/test/jobs-runs-db.test.ts`

**Interfaces:**
- Produces:
  - `RunRecord` gains `ownerId: string`; `NewRun` and `NewSkippedRun` gain `ownerId: string`.
  - `RunStore` request methods: `getRun(ownerId, id)`, `listRuns(ownerId, q)`, `statsSince(ownerId, since)`.
  - Internal (runner-only, keyed by an already-authorised run id, unchanged signatures): `markRunning`, `finishRun`, `updateStep`, `appendEvent`, `listEvents`. Route handlers call `listEvents` only after a successful scoped `getRun`.
  - `RunStore.system`: `{ getRun(id); listRuns(q) }`; global as today: `recoverInterrupted`, `pruneBefore`, `getRetentionDays`, `setRetentionDays`.
  - `services.ts` `lastScheduledRunAt(jobId)` uses `runs.system.listRuns`.
  - Manager active entries gain `ownerId`; `createRun`/`createSkippedRun` pass it.
  - Dashboard: `instances.list(ctx.user.id)`, `jobs.list(ctx.user.id)`, `runs.listRuns(ctx.user.id, …)`, `runs.statsSince(ctx.user.id, …)`.

- [ ] **Step 1: Write failing tests:**
  - API `runs are private to their owner`: admin starts a run; bob gets `GET /api/runs` total 0; `GET /api/runs/:id`, `POST /api/runs/:id/cancel`, `GET /api/runs/:id/log`, `GET /api/runs/:id/events` → 404, and the events response is not `text/event-stream`.
  - API `dashboard shows only the caller's data`: bob's `/api/dashboard` has empty `instances`, `recentRuns`, `running`, `nextScheduled` and zero stats while admin's are populated.
  - Skipped run records carry the job owner (`dashboard-skipped-retention.test.ts`).
  - Retention prune still removes old runs of every owner.
- [ ] **Step 2: Run** the two test files — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test`, `bun run typecheck`, DB tests — expect PASS.
- [ ] **Step 5: Commit** `git commit -am "Scope runs, events and the dashboard to their owner"`

### Task 5: Users being deleted are locked out

**Files:**
- Modify: `backend/src/auth/users.ts`, `backend/src/auth/auth.ts`, `backend/src/runs/manager.ts`, `backend/src/services.ts`, `backend/src/index.ts`, `backend/test/helpers.ts`
- Test: `backend/test/users-api.test.ts`, `backend/test/users-db.test.ts`, `backend/test/scheduler.test.ts`

**Interfaces:**
- Produces:
  - `User` gains `deletingAt: string | null`.
  - `UserStore.markDeleting(id: string, at: Date): Promise<User | null>` (null when missing; throws `LastAdminError` under the same rule as `delete`, so a doomed last admin is never locked out).
  - Login with a user whose `deletingAt` is set behaves exactly like a wrong password (same message, same backoff). `protect` rejects such a session with 401.
  - `RunManagerDeps.owners: { isDeleting(ownerId: string): Promise<boolean> }`; `start()` throws `HttpError(409, "This account is being deleted.")` when true; the scheduler catches it and logs (no skipped record).
  - `createJobRunServices` options gain `owners`.

- [ ] **Step 1: Write failing tests:** `login is refused once deletion started`; `existing session is rejected after markDeleting`; `scheduler does not start a run for an owner being deleted` (fake owners returning true; expect no run created).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** (pg: `update users set deleting_at = $2 where id = $1 returning …` with the last-admin check in the same transaction as `delete` uses).
- [ ] **Step 4: Run** `bun test`, typecheck, DB tests — PASS.
- [ ] **Step 5: Commit** `git commit -am "Lock out users whose deletion has started"`

### Task 6: Delete user = cancel, wait, erase

**Files:**
- Create: `backend/src/auth/user-deletion.ts`
- Modify: `backend/src/auth/user-routes.ts`, `backend/src/server.ts`, `backend/src/index.ts`, `backend/src/runs/manager.ts`, the three stores (add erase helpers), `backend/test/helpers.ts`
- Test: `backend/test/users-api.test.ts`, `backend/test/users-db.test.ts`

**Interfaces:**
- Consumes: `markDeleting` (Task 5), `jobs.system.disableSchedules` (Task 2), owned stores (Tasks 2–4).
- Produces:
  - `RunManager.cancelOwner(ownerId: string): string[]` (aborts every active entry — queued or running — with that owner; returns run ids) and `RunManager.waitFor(runIds: string[], timeoutMs: number): Promise<boolean>` (true when all finished).
  - `UserDataEraser = { counts(userId): Promise<{ instances: number; jobs: number; runs: number }>; erase(userId): Promise<void> }`. `pgUserDataEraser(sql)`: one transaction deleting `runs` (cascades steps/events) → `jobs` (cascades steps/schedules) → `instances` → `users` row, all `where owner_id = $1` / `id = $1`. `memoryUserDataEraser({ users, instances, jobs, runs })` for tests.
  - `createUserDeletion({ users, sessions, jobs, manager, eraser, timeoutMs = 60_000 })` → `remove(actorId, userId): Promise<"deleted" | "stopping" | "not_found">`. Order: self-check (409, existing message) → `markDeleting` (LastAdminError → existing 409) → `sessions.deleteForUser` → `jobs.system.disableSchedules` → `cancelOwner` → `waitFor` → `eraser.erase`.
  - `DELETE /api/users/:id`: `deleted` → 200 `{ deleted: true }`; `stopping` → 409 `{ message: "Runs are still stopping. Try again." }`; `not_found` → 404. Retrying after `stopping` re-runs the same sequence.
  - New admin route `GET /api/users/:id/data` → `{ instances, jobs, runs }` from `eraser.counts`.
  - `GET /api/users` items include `deletingAt`.

- [ ] **Step 1: Write failing tests:**
  - `deleting a user erases only their data`: bob has an instance, job with schedule, finished run; admin deletes bob → 200; DB/memory has none of bob's rows; admin's rows intact; bob's login fails.
  - `deleting a user cancels their active run first`: FakeExecutor holds bob's run running; delete → the executor's signal is aborted before erase; run records gone afterwards.
  - `queued run behind another user's lock is cancelled; the other run continues` (Review Focus 5).
  - `timeout returns 409 and keeps data`: executor ignores abort, `timeoutMs: 50`; delete → 409 with the exact message; bob's rows still present; bob cannot log in; schedules disabled; after releasing the executor, a second delete → 200.
  - `data preview counts`: `GET /api/users/:id/data` → `{ instances: 1, jobs: 1, runs: 1 }`; non-admin → 403.
  - Existing self-delete and last-admin tests still pass.
- [ ] **Step 2: Run** `bun test test/users-api.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `bun test`, typecheck, DB tests — PASS.
- [ ] **Step 5: Commit** `git commit -am "Delete users by cancelling their runs and erasing their data"`

### Task 7: First-run setup claims ownerless data

**Files:**
- Modify: `backend/src/auth/users.ts` (`pgUserStore.createFirstAdmin`)
- Test: `backend/test/users-db.test.ts` (DB-gated)

**Interfaces:**
- `createFirstAdmin` keeps its signature; in pg, the same transaction that inserts the first admin runs `update instances|jobs|runs set owner_id = $newId where owner_id is null`. Memory store unchanged (memory stores never hold ownerless rows).

- [ ] **Step 1: Write failing test** `setup assigns ownerless rows to the first admin`: empty users, insert an instance/job/run with `owner_id null`, call `createFirstAdmin` → all three owned by the new user; a second call returns null and changes nothing.
- [ ] **Step 2: Run** with `TEST_DATABASE_URL` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -am "Give ownerless data to the first admin at setup"`

### Task 8: Users screen and documentation

**Files:**
- Modify: `frontend/src/Users.svelte`, `frontend/src/lib/users.ts`, `frontend/src/lib/api.ts`
- Test: `frontend/src/lib/users.test.ts`
- Modify: `README.md`, `AGENTS.md`, `SPEC.md`

**Interfaces:**
- Consumes: `GET /api/users/:id/data`, `deletingAt` on users, the 409 message (Task 6).
- Produces: `api.getUserData(id): Promise<{ instances: number; jobs: number; runs: number }>`; pure helper `deleteWarning(counts): string` in `lib/users.ts` returning e.g. `"This erases 2 instances, 3 jobs and 41 runs. Nothing on your Immich servers is changed."` (singular/plural handled; zero counts omitted; all zero → `"This user has no instances, jobs or runs. Nothing on your Immich servers is changed."`).
- Delete confirmation (existing pattern in `Users.svelte`) loads counts and shows `deleteWarning`; a 409 shows the server message; users with `deletingAt` show a `badge preset-tonal-warning` "Deleting…" and a "Retry delete" button.

- [ ] **Step 1: Write failing tests** for `deleteWarning` (plural, singular, zero-omitted, all-zero).
- [ ] **Step 2: Run** `bun test frontend/src/lib/users.test.ts` — FAIL.
- [ ] **Step 3: Implement** helper, API method and UI.
- [ ] **Step 4: Run** `bun test`, `bun run typecheck`, `bun run build` — PASS.
- [ ] **Step 5: Update docs:** README (each user's own instances/jobs/runs; admin = user management + retention; deletion behaviour), AGENTS.md project-status paragraph (same facts), SPEC.md glossary/Instance row (ownership rule).
- [ ] **Step 6: Commit** `git commit -am "Show what deleting a user erases; document per-user ownership"`
