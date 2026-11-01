# Immich Sync

Copy, move and sync photos and videos between Immich servers you have API keys for, from a web UI, with dry runs, schedules and batch jobs.

> **Status: early implementation.** Implemented today:
>
> - **Engine (`core`)**: read-only copy/move preview, streamed copy with target checksum verification, move (copy, verify, then source trash only), and partial metadata sync (favorites, archive/timeline visibility, descriptions, ratings, GPS, date taken, opt-in tags and additive album membership). Complete metadata sync is not implemented.
> - **Backend**: first-run setup and multi-user accounts (admin and user roles; server-side sessions, CSRF protection), instances API with encrypted API keys and a connection check, jobs and schedules CRUD, per-instance write locks, runs executed in the backend with stored history, structured logs and live events over SSE, and a scheduler that fires schedules in their time zone.
> - **Frontend**: login and first-run setup, Settings, Users (counted deletion confirmation), and a Dashboard with a summary, running runs and an instance map built with Svelte Flow: instances are nodes, job steps are lines labelled with the job's schedule or last result, a running job shows its live percentage once the run reports progress (real runs; a dry run reports counts and log lines only), and clicking a line (or its label) opens a job panel (progress, counts, recent log lines, Open job, Dry run). Jobs that run between the same two instances are drawn in separate lanes. Instances are added, edited, tested and deleted from a side panel on the map (Map or List view); there is no separate Instances screen. The Run screen (copy, move or metadata sync, dry run on by default) has a live console with a per-step summary and a run diagram (a Preflight box and one box per step with its status and progress; clicking a step filters the console), and History replays and downloads logs with the same diagram. The Jobs screen lists saved jobs (steps, schedule, next runs, last run); its job editor draws the steps as a pipeline (add by clicking or dragging from a palette, drag to reorder, per-step settings and a checks list), next to a schedule editor (presets or cron, IANA time zone, pause, optional catch-up, explicit confirmation for jobs containing a move) and Run now / Dry run. Not verified against a live Immich. Checked by hand in a browser against a local dev server: the dashboard map and instance panel, the job pipeline editor and a finished run's diagram. Also checked: a dry run's live diagram, map badges, counts and log lines, drag-to-reorder with a real mouse, editing a job, a paused schedule and "Edit schedule". A real copy of a few assets (last 30 days, between two real servers) was also watched live: the percentage on the map line, the progress bar in the job panel and the run diagram. A real move of 3 assets (verified on the target, then sent to the source server's trash) and a real metadata-sync run that found nothing to change were also watched. A scheduled run was also watched (an hourly schedule fired on time and the dashboard listed its next run). A metadata-sync run that writes a field was also watched: one photo favorited on the source was synced to the target, and a second dry run then showed every shared photo unchanged. Not every field type has been exercised that way (only the favorite flag so far). There is no mobile layout yet: the diagrams only pan and zoom on small screens.
>
> Verification: the engine, executor and scheduler are tested against a fake Immich server and fake clocks. The author has also done a first dry run and copy against real servers; move, metadata sync and scheduled runs are not yet verified on a live Immich. Treat everything as pre-release and start with dry runs.

## Requirements

- Immich **v3.3 or newer** on every server (tested with v3.3.x; v3.2 is not supported). When source and target run different versions, the app warns before a step runs.
- To run it: Docker with Compose.
- To develop it: [Bun](https://bun.sh) 1.4+ and Docker (for the development database).

## Run with Docker Compose

```bash
cp .env.example .env
# fill in POSTGRES_PASSWORD and SECRET_KEY (openssl rand -hex 32)
bun run app:up              # or: docker compose up -d --build / podman compose up -d --build
```

Docker and Podman both work. `bun run app:up` picks the runtime automatically (Docker if installed, otherwise Podman); force one with `bun run app:up:docker` or `bun run app:up:podman`, or set `CONTAINER_RUNTIME=docker|podman` in `.env`. `bun run app:logs` follows the app log and `bun run app:down` stops the stack (data stays in `./postgres`).

Then open http://localhost:8080.

### First run and accounts

There is no admin password in the environment. Open the app: while no user exists you are sent to `/setup` to create the first account, which becomes an administrator; after that `/setup` is closed (`POST /api/setup` answers 409 and creates nothing). Administrators manage accounts under `/api/users` (create, change role, reset a password, delete); the `user` role can use everything except user management and the history-retention setting. The last administrator cannot be deleted or demoted, and nobody can delete their own account. Usernames are 3-64 characters (letters, digits, `.`, `_`, `-`), unique ignoring case; passwords are 12-256 characters and stored as argon2id hashes. Changing your own password (Settings, `POST /api/auth/password`) or having it reset by an administrator signs out that user's other sessions.

### Data ownership and upgrades

Every account, administrators included, sees and manages only its own instances, jobs, schedules, runs, history, logs and dashboard. Aliases and the default instance are per user. A job may only use that user's instances. Administrators have no access to other users' data; their extra powers are account management and the global history-retention setting.

Deleting an account first locks it out, ends its sessions, disables its schedules and cancels its runs. Once those runs stop, all its app data (instances, jobs, schedules, runs, history and logs) is permanently erased. The Users screen previews the counts before confirmation. **Nothing on any Immich server is touched.** If runs have not stopped within 60 seconds, deletion returns 409, keeps the data and leaves the account locked out; retry deletion after the runs stop. The Users screen marks locked-out accounts “Deleting…” and offers “Retry delete”. The last usable administrator cannot be deleted or demoted, even if another admin is already being deleted.

On upgrade, existing rows are assigned to the oldest administrator. If no user exists yet, ownerless rows stay hidden until first-run setup assigns them to the new first administrator in the same transaction. Later setup attempts cannot claim or reassign data. Back up the database before upgrading.

Forgotten the only admin password? Recover that existing account through a database administrator: stop the app, back up the database, replace that account's `users.password_hash` with a fresh argon2id hash generated with the parameters in `backend/src/auth/auth.ts`, and delete its sessions before restarting. Do not delete accounts to reopen setup: ownership foreign keys intentionally prevent it, and account deletion through the API erases the account's app data. Do not clear `deleting_at` to undo a deletion in progress. Keep the deployment on localhost during recovery.

Failed logins (and failed password confirmations) back off per client address; behind a reverse proxy every request shares the proxy's address, so set `TRUST_PROXY=true` (default `false`) to key the backoff on the first `X-Forwarded-For` hop. Enable it only when a proxy you control sets that header and the app is not reachable directly, otherwise clients can spoof it. A leftover `ADMIN_PASSWORD` in an old `.env` is ignored.

- The app listens on **localhost only** by default (`127.0.0.1:8080`). It holds API keys that can trash photos, so put it behind a reverse proxy with HTTPS before exposing it on a network.
- PostgreSQL data lives in `./postgres`. No photos are stored by the app: originals are streamed from one Immich server to the other.

## Develop

```bash
bun install
cp .env.example .env        # fill in SECRET_KEY; DATABASE_URL already points at the dev database
bun run db:up               # PostgreSQL 17 on localhost:55432 (docker-compose.dev.yml); docker or podman, see CONTAINER_RUNTIME
bun run dev                 # backend on :8080 (auto-reload) + frontend on :5173 (proxies /api)
```

Keep `PORT=8080` (the value in `.env.example`) while developing: the Vite proxy reads `PORT` from the same `.env`, and any other value can make the backend and Vite compete for port 5173.

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
3. **Frontend**: Run form, console, History, the Jobs screen with its pipeline and batch editor, and the Dashboard with the instance map (which also manages instances) are in place. Next: browser verification of live runs, and a mobile layout.
4. **Release**: multi-arch image (amd64, arm64) on GHCR, docs.

## Releases

Pushing a tag that starts with `v` (for example `v0.1.0`) runs `.github/workflows/release.yml`, which builds a multi-arch image (linux/amd64 and linux/arm64) and pushes it to `ghcr.io/rafe95/immich-sync`. Tags are `0.1.0`, `0.1`, `0` (not for `v0.x`) and `latest` (stable tags only, not pre-releases like `v0.2.0-rc.1`). The workflow can also be started manually from the Actions tab, which pushes a `sha-...` tag. CI (`.github/workflows/ci.yml`) runs typecheck, build and tests, including the database tests, on every push and pull request to `main`. The workflows have not been run on GitHub yet.

To run the published image, edit the `app` service in `docker-compose.yml` as described in its comment (use `image: ghcr.io/rafe95/immich-sync:<tag>` and drop `build: .`), then `docker compose up -d`. A new GHCR package is private until its visibility is changed in the GitHub package settings.

The licence is not chosen yet (see below), so published images carry no licence label.

## License

Not chosen yet. Note that `@immich/sdk` is licensed AGPL-3.0, which matters for how this project is licensed and distributed.
