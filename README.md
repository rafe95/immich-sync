# Immich Sync

Copy, move and sync photos and videos between Immich servers you have API keys for, from a web UI, with dry runs, schedules and batch jobs.

> **Status: early implementation (phase 1).** `core` provides a read-only copy/move preview, copy-only execution that streams originals and verifies target checksums, core-only move execution (copy, verify, optional partial metadata sync, then source trash only), and a selected-asset metadata-fields operation for favorites, timeline/archive visibility, nonempty descriptions, ratings, complete GPS pairs, date taken with a resolvable time zone offset, opt-in tags (matched by exact value, created on the target if missing, additive), and opt-in additive owned-album membership matched by exact name (creating missing albums is a separate opt-in). Full metadata sync beyond these fields, backend/UI integration of move, jobs, scheduling and the full UI are not implemented yet; none of these engine APIs is exposed through the backend or UI. The backend implements single-admin login (server-side PostgreSQL sessions, HttpOnly SameSite=Strict cookie, per-session CSRF token in the `X-CSRF-Token` header, login throttling) and an instances API (`/api/instances` CRUD plus `POST /api/instances/:id/check`; API keys encrypted at rest with `SECRET_KEY` and never returned); the backend also has jobs and runs infrastructure: `/api/jobs` CRUD with ordered steps, `/api/jobs/:id/schedule` (cron + IANA time zone, enabled, catch-up flag; a move job needs `confirmMove`), `POST /api/jobs/:id/run` and `POST /api/runs` (202, executed in the backend), run history at `/api/runs`, `POST /api/runs/:id/cancel`, the JSON log at `/api/runs/:id/log` and live events over SSE at `/api/runs/:id/events` (resumes from `Last-Event-ID` or `?after=`), per-instance write locks, startup recovery of interrupted runs and a history-retention helper (default 90 days). The backend step executor (`createCoreExecutor` in `backend/src/runs/executor.ts`) validates every participating instance with core's check before step 1 and runs each step through core's `runStep`, forwarding its events into the run log; step options also accept `includeAlbums`, `createMissingAlbums` and `includeTags` (they require metadata sync). The scheduler (`backend/src/scheduler.ts`) fires enabled schedules in their time zone through the same run manager (`trigger=schedule`), skips a firing while the job's previous run is active, does not fire paused schedules or unconfirmed move jobs, catches up a missed occurrence once only when `catchUp` is set, and reloads when schedules change. This is covered by fake-server and fake-clock tests only and has not been verified against a live Immich server; the frontend covers login/logout, the Instances screen (list, add, edit, delete, set default, Test connection), a Run screen (one-off copy/move/sync-metadata form, dry run on by default, confirmation before a real move, live console over SSE with resume, cancel) and a History screen (status filter, pagination, stored-log replay, text/JSON log download); Dashboard is a placeholder and Jobs is a disabled placeholder. The Run form sends only what the backend accepts today (date window, kind, metadata on/off, dry run); album and tag options are not offered because the run API has no fields for them. See [SPEC.md](SPEC.md) for the full specification and the roadmap below.

## Requirements

- Immich **v3.2 or newer** on every server (tested with v3.2.4 and v3.3.x). When source and target run different versions, the app warns before a step runs.
- To run it: Docker with Compose.
- To develop it: [Bun](https://bun.sh) 1.4+ and Docker (for the development database).

## Run with Docker Compose

```bash
cp .env.example .env
# fill in POSTGRES_PASSWORD, ADMIN_PASSWORD and SECRET_KEY (openssl rand -hex 32)
bun run app:up              # or: docker compose up -d --build / podman compose up -d --build
```

Docker and Podman both work. `bun run app:up` picks the runtime automatically (Docker if installed, otherwise Podman); force one with `bun run app:up:docker` or `bun run app:up:podman`, or set `CONTAINER_RUNTIME=docker|podman` in `.env`. `bun run app:logs` follows the app log and `bun run app:down` stops the stack (data stays in `./postgres`).

Then open http://localhost:8080.

- The app listens on **localhost only** by default (`127.0.0.1:8080`). It holds API keys that can trash photos, so put it behind a reverse proxy with HTTPS before exposing it on a network.
- PostgreSQL data lives in `./postgres`. No photos are stored by the app: originals are streamed from one Immich server to the other.

## Develop

```bash
bun install
cp .env.example .env        # fill in ADMIN_PASSWORD and SECRET_KEY; DATABASE_URL already points at the dev database
bun run db:up               # PostgreSQL 17 on localhost:55432 (docker-compose.dev.yml); docker or podman, see CONTAINER_RUNTIME
bun run dev                 # backend on :8080 (auto-reload) + frontend on :5173 (proxies /api)
```

Open http://localhost:5173.

| Command | What it does |
| --- | --- |
| `bun test` | All tests. Database tests run only when `TEST_DATABASE_URL` is set, e.g. `TEST_DATABASE_URL=postgres://immich_sync:devpassword@localhost:55432/immich_sync bun test` |
| `bun run typecheck` | TypeScript in every package, `svelte-check` for the frontend |
| `bun run build` | Builds the frontend into `frontend/dist` |
| `bun run start` | Runs the backend (serves `frontend/dist` when `STATIC_DIR` is set) |
| `bun run db:down` | Stops the development database |
| `bun run db:up:docker` / `db:up:podman` | Start the development database with a specific runtime |
| `bun run app:up` / `app:down` / `app:logs` | Build and start, stop, or follow the logs of the full app stack (`app:up:docker` and `app:up:podman` force a runtime) |

## Layout

| Folder | Contents |
| --- | --- |
| `core/` | Pure TypeScript on the official `@immich/sdk`: instance checks, read-only copy/move preview, streamed copy execution with target checksum verification, and partial metadata-field sync for explicitly selected assets, including optional additive album membership; `moveAssets` adds verify-before-trash move execution (source trash only, never permanent deletion); `runStep` (core/src/step.ts) is a single core entry point for a copy, move or sync_metadata step (normalized result and events delivered live through `onEvent` with progress events, metadata wait before sync, dry run; `sync_metadata` needs no upload permission); complete metadata sync and backend/UI integration remain future work. |
| `backend/` | Bun HTTP server: `/api/*`, PostgreSQL via `Bun.sql`, SQL migrations in `src/db/migrations`, serves the built frontend. |
| `frontend/` | Svelte 5 + Vite + Skeleton (Tailwind 4) single-page app. |
| `SPEC.md` | What the app does and why. |

## Roadmap

1. **Engine** (`core`, in progress): read-only preview, streamed copy with target checksum verification, and selected-asset partial metadata-field sync (including opt-in additive album membership) are implemented. Core-only `moveAssets` (verify-before-trash) and the `runStep` step runner (copy/move/sync_metadata, bounded wait for the target to read uploaded files' metadata, not yet verified against a live Immich) exist too; the backend does not call them yet. Next: remaining metadata synchronization, with the Python script's safety scenarios ported as tests against a fake Immich server.
2. **Backend**: login, instances API (encrypted keys, Test connection), jobs, job runner with locks, live logs over SSE, history, scheduler.
3. **Frontend**: Run form with dry run, console, Instances, Jobs and batch editor, History, Dashboard.
4. **Release**: multi-arch image (amd64, arm64) on GHCR, docs.

## License

Not chosen yet. Note that `@immich/sdk` is licensed AGPL-3.0, which matters for how this project is licensed and distributed.
