# Per-user ownership of instances, jobs and runs

Date: 2026-10-31 · Status: approved direction, ready for planning
Comes before: `2026-10-31-svelte-flow-ui-design.md` (the map and dashboard instance management show only the signed-in user's data).

## Intent

Immich Sync has multi-user accounts, but everything else is shared: any signed-in user can see, edit,
run and delete every instance, job, schedule and run. An instance is one person's Immich API key
(SPEC: "Keys are per user, so two users on one server are two instances"), so sharing them lets one
user copy, move or trash another user's photos. Each user must work only with their own data.

The owner decided:

- Each user manages their own instances; instances have jobs, and so on down (schedules, runs, history).
- This applies to administrators too. An admin's extra powers are **managing users** (and the existing
  global history-retention setting); an admin does not see or manage other users' instances, jobs or runs.
- When a user is deleted, their jobs are cancelled and **all data that belongs to them is erased**.

## Goals

- Every instance, job, schedule, run and run event has exactly one owning user.
- Every API route that reads or changes them is scoped to the signed-in user.
- A job can only use instances owned by the same user, checked when saved and again when a run starts.
- Deleting a user cancels their runs safely and then erases their data.
- Existing installations keep their data after upgrading.

## Non-goals

- Sharing instances or jobs between users, teams, or an admin "view as" mode.
- Changes to Immich itself: deleting a user never touches anything on any Immich server.
- Frontend redesign (that is the Svelte Flow design); this change only needs the existing screens to keep working and the Users screen's delete confirmation to say what will be erased.

## Anti-goals

- Leaking existence of another user's objects: guessing an id must not reveal whether it exists.
- Erasing data while a run that uses it is still writing to Immich.
- A cancellation path that trashes unverified or half-completed assets (existing safety rule still holds).

## Data model (new migration `0005_ownership.sql`; never edit applied migrations)

- `instances.owner_id uuid references users (id)` (nullable only for the no-users upgrade case below; every query filters `owner_id = $owner`, so an ownerless row is invisible to everyone).
  - Alias uniqueness becomes per owner: drop the global `unique` on `alias`, add `unique (owner_id, alias)`. Case rule stays as it is today.
  - Default instance becomes one per owner: replace `instances_single_default` with a unique partial index on `(owner_id) where is_default`.
- `jobs.owner_id uuid references users (id)`, same nullability rule. Job names are not unique today and stay that way.
- `runs.owner_id uuid references users (id)`, same nullability rule.
- `users.deleting_at timestamptz` (null normally): set when a deletion starts; see "Deleting a user". Needed because ad-hoc runs have no job and runs outlive their job (`job_id ... on delete set null`).
- `job_steps`, `schedules`, `run_steps`, `run_events` inherit ownership through their parent; no new column.
- Indexes on each `owner_id`.
- Backfill: the migration assigns every existing instance, job and run to the **oldest administrator** (`order by created_at limit 1`). If the database has data but no users yet (an upgrade from before accounts, setup not yet done), the rows stay ownerless and `/api/setup` assigns all ownerless rows to the new admin in the same transaction that creates them (*design call*). No data is lost, and ownerless rows are never visible or runnable.
- Deletion order: `job_steps.source_id/target_id ... on delete restrict` stays, so user erasure deletes explicitly in one transaction (runs → jobs → instances → user) rather than relying on cascade order (*design call*).

## Behaviour

### Scoping

- Instances, jobs, schedules, runs (list, get, cancel, log, SSE events), and the dashboard summary return only the signed-in user's objects.
- Another user's object answers **404**, the same as a missing one (*design call*).
- Creating a job, or editing its steps, fails with 400/422 if any step references an instance not owned by the caller (it will usually 404 at lookup anyway). When a run starts, the run manager's `snapshot()` resolves step instances with an owner-filtered lookup (replacing today's unscoped `instances.list()` check), so a manual (`jobs/routes.ts`), ad-hoc (`runs/routes.ts`) or scheduled (`scheduler.ts`) run never uses another user's instance.
- `/api/runs` ad-hoc runs: same rule for the instances in the request.
- Admin-only routes are unchanged: `/api/users`, retention setting. Retention pruning stays global (applies to every user's history).

### Scheduler and locks

- The scheduler keeps firing all users' schedules; each run gets its job's `owner_id`. Skipped-run records get it too.
- Write locks stay per instance id. Two users with keys for the same Immich server are two instances and don't block each other.

### Deleting a user (admin)

Existing rules stay: not yourself, never the last admin. Then, in order:

1. Set `users.deleting_at` and delete the user's sessions in one transaction. From then on the user cannot sign in, and the run manager refuses to start any run (manual, ad-hoc or scheduled) owned by a user with `deleting_at` set (*design call*: a user being deleted is locked out even if step 4 times out).
2. Disable the user's schedules, so nothing fires while the deletion completes.
3. Cancel every active or queued run owned by the user through the run manager's normal cancellation (which stops after the current batch and never trashes unverified assets).
4. Wait for those runs to finish stopping, with a bounded timeout (builder picks the value, roughly a minute). If they don't stop in time, answer **409** "runs are still stopping, try again" and leave the user's data in place. The user stays locked out and the schedules stay disabled; retrying the delete continues from step 3. The Users screen shows such a user as "Deleting…".
5. In one transaction erase all their data: runs (and run steps/events), jobs (and steps/schedules), instances (including the encrypted API keys), then the user row.

The Users screen's delete confirmation states what will be erased (counts of instances, jobs, runs) and that nothing on the Immich servers is touched. A small endpoint or an extra field for those counts is fine.

## Tests (DB tests gated by `TEST_DATABASE_URL`)

- Two users: each sees only their own instances, jobs, schedules, runs, events, dashboard; cross-user ids return 404 for get, update, delete, run, cancel, log, SSE.
- Same alias and both "default" allowed for two different users; still unique within one user.
- Job referencing another user's instance is rejected on create, update and run start.
- Scheduler-fired and skipped runs carry the job owner.
- Migration backfill assigns existing rows to the oldest admin; an empty database migrates cleanly; data with no users stays ownerless and invisible until `/api/setup` assigns it.
- User deletion: active run is cancelled (no trash of unverified assets, via the fake Immich server), data erased, other users' data untouched; timeout path returns 409, keeps data, blocks login and new runs, and a retry completes; last-admin and self-delete rules still hold.

### Internal (system) access

The scheduler (`listSchedules`, `jobs.get`), startup recovery (`recoverInterrupted`), global retention pruning and the delete-user flow legitimately read across users. They use a separate, explicitly named unscoped API (for example `store.system.*`), used only from those places (*design call*). Everything reachable from a request handler uses the owner-scoped API.

## Left to the builder

- Where scoping lives (store methods taking `ownerId` vs a route-level guard). Every request-path store method for these tables takes the owner, so a missing filter is a type error, not a silent leak; only the system API above is unscoped.
- The exact timeout and how "stop new work" is implemented.
- Shape of the delete-preview counts.

## Done when

- All of the above holds with tests; `bun test` (with and without `TEST_DATABASE_URL`) and `bun run typecheck` pass.
- `README.md` and `AGENTS.md` describe per-user ownership and the admin's role as implemented; `SPEC.md` notes the ownership rule.
