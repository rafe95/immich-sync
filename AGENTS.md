# Agent and contributor instructions

## Project status and sources of truth

- This repository has moved from the phase-0 scaffold into an early phase-1 implementation. The workspace, database schema, health endpoint, Immich instance checks, fake Immich server, frontend shell, read-only copy/move preview, core-only streamed copy with target checksum verification, core-only move execution (`moveAssets`), and selected-asset partial metadata-field sync exist. The metadata operation supports favorites, timeline/archive visibility, nonempty descriptions, ratings, complete GPS pairs, date taken with a resolvable time zone offset, opt-in tags (matched by exact value, created on the target if missing, additive), and opt-in additive owned-album membership matched by exact name (creating missing albums is a separate opt-in). Full metadata sync, backend/UI integration of move, jobs, scheduling, and the full UI are not implemented yet. Backend single-admin authentication (PostgreSQL sessions, CSRF), the instances API (encrypted keys, connection check), jobs/schedules CRUD, per-instance write locks, a run store with history/retention and SSE events, and run orchestration around an injected `StepExecutor` exist, but that executor is not yet wired to `core` and nothing fires schedules, so real runs fail at validation; the frontend is not wired to them. Do not describe planned behavior as existing functionality.
- `SPEC.md` is the product specification. Follow its goals, safety rules, and out-of-scope list; `README.md` documents current implementation, supported commands, and the roadmap. If implementation reality and the specification differ, preserve the distinction and update the relevant docs when behavior changes.
- Implement incrementally in the existing packages. Avoid introducing unrelated infrastructure or replacing the selected stack without an explicit requirement.

## Workspace and commands

This is a Bun workspace with `core`, `backend`, and `frontend` packages. From the repository root:

```bash
bun install
bun run db:up              # docker or podman: CONTAINER_RUNTIME=docker|podman|auto, see scripts/compose.sh
bun run dev
bun test
bun run typecheck
bun run build
bun run db:down
```

- `bun run dev` starts the backend on port 8080 and the Vite frontend on port 5173; the frontend proxies `/api` to the backend.
- Database integration tests run only when `TEST_DATABASE_URL` is set. For the development database, use `TEST_DATABASE_URL=postgres://immich_sync:devpassword@localhost:55432/immich_sync bun test`.
- `bun run build` builds the frontend into `frontend/dist`; `bun run start` starts the backend and serves that build when `STATIC_DIR` is set.
- For deployment, use Docker Compose as documented in `README.md`. The app should bind to localhost by default; network exposure requires HTTPS and a reverse proxy.

Run focused tests for changed behavior, then `bun test` and `bun run typecheck` when the scope warrants it. There is no separate lint command defined in the root package scripts.

## Package boundaries and conventions

- `core/`: pure TypeScript engine code using the official `@immich/sdk`; keep HTTP server, database, and UI concerns out of this package. The copy/move planner is read-only; `copyAssets` supports copy-only execution with streamed originals and target checksum verification, with metadata sync explicitly disabled. `syncMetadataFields` is a selected-asset building block limited to favorites, timeline/archive visibility, nonempty descriptions, ratings, complete GPS pairs, date taken with a resolvable time zone offset, opt-in tags (matched by exact value, created on the target if missing, additive), and opt-in additive owned-album membership matched by exact name (creating missing albums is a separate opt-in); `moveAssets` copies, then trashes (never force-deletes) on the source only assets verified on the target by checksum and, when enabled, successfully metadata-synced via `syncMetadataFields`; `runStep` (`core/src/step.ts`) is the single step entry point for copy, move and `sync_metadata` (assets already on both sides, never uploads); it waits (bounded, abortable, injectable delay) for the target's `exifInfo` before metadata sync and reports a timeout as a metadata failure so a move does not trash the asset; `runStep` delivers asset and typed `progress` events live through `onEvent` (copyAssets/moveAssets/syncMetadataFields take optional `onAsset`/`onProgress`; `result.events` stays complete and ordered), and `sync_metadata` planning requires only metadata-sync permissions (source read; target read + `asset.update`; album/tag permissions only for enabled options), not `asset.upload`; full metadata sync, backend job ownership, and UI integration are not implemented.
- `backend/`: Bun HTTP/API server, PostgreSQL access through `Bun.sql`, SQL migrations, and (as implemented) execution, scheduling, authentication, and log streaming. The backend owns job execution; browser lifetime must not control a run. `createCoreExecutor` (runs/executor.ts) runs steps through core's `runStep`, and `scheduler.ts` fires schedules through the run manager; both are verified only with the fake Immich server and fake clocks, not a live Immich.
- `frontend/`: Svelte 5 + Vite + Skeleton (Tailwind 4). Follow existing Svelte 5 patterns, including runes where used, and keep Immich API credentials and direct Immich traffic out of the browser.
- Follow the surrounding TypeScript style, package boundaries, and existing APIs. Prefer small, typed changes and update tests and documentation alongside behavior changes.
- Database migrations are plain SQL files named `NNNN_description.sql`, applied in name order and each in its own transaction. Add a new migration for schema changes; do not silently rewrite an already-applied migration.

## Immich integration

- Use `@immich/sdk` for Immich API calls. Supply each call with that instance's own `RequestOpts` (`baseUrl` and `x-api-key`); do not use the SDK's global `init()`, because a step talks to source and target servers side by side.
- An instance represents one server and one user's API key. Validate inputs consistently with `core/src/instance.ts`; aliases and API URLs must not be used to smuggle credentials into logs or browser responses.
- Require Immich v3.2 or newer as specified. Check endpoint and permission behavior against the supported Immich versions: the exact permission list in `SPEC.md` is explicitly provisional and must be verified rather than assumed.
- Use per-instance connection and permission checks before a job depends on an instance. For a batch, validate every participating instance before the first step can make changes.

## Data safety invariants

These are hard requirements for any transfer or mutation implementation:

- A dry run makes no changes on either Immich server. It may inspect assets and compare metadata, then report the prospective work.
- Stream original media from source to target; do not persist photo or video payloads in local files or temporary staging. Verify target presence by checksum before considering an asset transferred.
- Never permanently delete assets. A move may put an asset in the source server's trash **only after** target verification and, when enabled, successful metadata synchronization for that asset.
- Never re-upload an asset found only in the target's trash; report and skip it. Skip assets already present on the target so reruns remain safe and idempotent.
- Refuse a source and target that are the same server and same user. Partner-shared assets and trashed source assets are excluded as specified.
- A failure on one asset should be logged and handled according to the operation's rules without losing already verified work. Cancellation must not trash unverified or half-completed assets.
- Preserve metadata semantics from `SPEC.md`: source values are applied where they differ, target-only data is not removed, and people/face names are not synced.
- Keep the backend as the only component that communicates with Immich. Do not return API keys to the browser, include keys or credential-bearing URLs in logs, or weaken the default localhost deployment.

## Jobs, persistence, and logs

When implementing the planned job system, use `SPEC.md` as the behavior contract:

- Run manual, scheduled, and batch work through the backend-owned execution path. Persist run settings, status, summaries, and structured log events so history remains available after restart.
- Enforce per-instance write locks so concurrent jobs cannot write to the same target or move from the same source at once; unrelated instances may run in parallel.
- Run batch steps in order. Validate all instances before step 1, and record skipped/not-run outcomes when a step stops the job.
- Keep structured progress and summary events usable by both the live console and history. SSE reconnects should resume from the last event received.
- Schedules must honor their time zone, enabled/paused state, no-overlap rule, and documented missed-run default. A scheduled move requires explicit confirmation when configured.
- State-changing API requests require authentication and CSRF protection. Encrypt stored API keys with `SECRET_KEY`; fail closed when required secrets are absent.

## Tests

- Add or extend tests with behavior changes. For engine integration scenarios, use the fake Immich server pattern in `core/test/fake-immich.ts` and test both successful and negative paths. Planner tests cover paginated filtering, checksum classification, target-trash handling, Live Photo components, preflight and read-only behavior; copy tests cover streaming, verification, reruns, cancellation, per-asset failures and Live Photo linking; metadata-field and metadata-album tests cover the supported partial operations, exact-name matching, additive membership, ownership, permissions, dry runs, cancellation and failures. Fake-server tests do not prove live-server compatibility or complete metadata sync.
- Prioritize the safety scenarios from `SPEC.md`: target-trash handling, Live Photos, idempotent reruns, checksum verification, verify-before-trash, dry-run non-mutation, and per-asset failures.
- Database tests must be explicitly gated by `TEST_DATABASE_URL`; do not make ordinary tests depend on an implicit local database.
- Do not weaken or skip a failing test to make a change pass. Diagnose the behavior and fix the implementation or the test expectation when justified.