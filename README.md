# Immich Sync

Copy, move and sync photos and videos between Immich servers you have API keys for, from a web UI, with dry runs, schedules and batch jobs.

> **Status: early implementation.** Implemented today:
>
> - **Engine (`core`)**: read-only copy/move preview, streamed copy with target checksum verification, move (copy, verify, then source trash only), and partial metadata sync (favorites, archive/timeline visibility, descriptions, ratings, GPS, date taken, opt-in tags and additive album membership). Complete metadata sync is not implemented.
> - **Backend**: single-admin login (server-side sessions, CSRF protection), instances API with encrypted API keys and a connection check, jobs and schedules CRUD, per-instance write locks, runs executed in the backend with stored history, structured logs and live events over SSE, and a scheduler that fires schedules in their time zone.
> - **Frontend**: login, Instances, a Run screen (copy, move or metadata sync, dry run on by default, live console with a per-step summary), and History with log replay and download. The Jobs screen lists saved jobs (steps, schedule, next runs, last run) with a job and batch step editor (reorder, duplicate, per-step failure options), a schedule editor (presets or cron, IANA time zone, pause, optional catch-up, explicit confirmation for jobs containing a move) and Run now / Dry run. Not verified against a live Immich or in a browser beyond the build.
>
> Verification: the engine, executor and scheduler are tested against a fake Immich server and fake clocks. The author has also done a first dry run and copy against real servers; move, metadata sync and scheduled runs are not yet verified on a live Immich. Treat everything as pre-release and start with dry runs.

## Requirements

- Immich **v3.3 or newer** on every server (tested with v3.3.x; v3.2 is not supported). When source and target run different versions, the app warns before a step runs.
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
| `backend/` | Bun HTTP server: `/api/*`, PostgreSQL via `Bun.sql`, SQL migrations in `src/db/migrations`, serves the built frontend. Also: `GET /api/dashboard` (instances with last check, recent runs, next schedules, running runs, 7-day stats), `GET/PUT /api/settings/retention` (days, 1-3650, default 90; pruned at startup and daily), schedule firings skipped because the previous run is still active or a move is unconfirmed are stored in history as `skipped` runs, instance checks made during runs update the stored last check, and persisted `progress` events are limited to about one per second per step. All verified with the fake Immich server and fake clocks only. |
| `frontend/` | Svelte 5 + Vite + Skeleton (Tailwind 4) single-page app. |

## Safety

- A dry run changes nothing on either server; it only inspects and reports what would happen.
- Assets are never permanently deleted. A move can only put an asset in the source server's trash, and only after the copy is verified on the target by checksum (and, when metadata sync is on, after that succeeded for the asset).
- Assets found only in the target's trash are reported and skipped, never uploaded again. Assets already on the target are skipped, so reruns are safe.
- Source and target must be different (a server and user pair cannot be synced with itself).
- Originals are streamed from one server to the other and never stored by this app. Failures are handled per asset and cancelling a run does not trash anything unverified.
- API keys are encrypted at rest and never sent to the browser; the app listens on localhost by default.

## Roadmap

1. **Engine** (`core`, in progress): read-only preview, streamed copy with target checksum verification, and selected-asset partial metadata-field sync (including opt-in additive album membership) are implemented. Core-only `moveAssets` (verify-before-trash) and the `runStep` step runner (copy/move/sync_metadata, bounded wait for the target to read uploaded files' metadata, not yet verified against a live Immich) exist too; the backend does not call them yet. Next: remaining metadata synchronization, with the Python script's safety scenarios ported as tests against a fake Immich server.
2. **Backend**: login, instances API (encrypted keys, Test connection), jobs, job runner with locks, live logs over SSE, history, scheduler.
3. **Frontend**: Run form, console, Instances and History are done; the Jobs screen and batch editor are in place; Dashboard is being added.
4. **Release**: multi-arch image (amd64, arm64) on GHCR, docs.

## License

Not chosen yet. Note that `@immich/sdk` is licensed AGPL-3.0, which matters for how this project is licensed and distributed.
