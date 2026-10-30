# Immich Sync

Copy, move and sync photos and videos between Immich servers you have API keys for, from a web UI, with dry runs, schedules and batch jobs.

> **Status: early implementation (phase 1).** `core` provides a read-only copy/move preview, copy-only execution that streams originals and verifies target checksums, and a selected-asset metadata-fields operation for favorites, timeline/archive visibility, nonempty descriptions, ratings, complete GPS pairs, and opt-in additive owned-album membership matched by exact name. Full metadata sync beyond these fields, move execution/source trash, jobs, scheduling, authentication and the full UI are not implemented yet; none of these engine APIs is exposed through the backend or UI. See [SPEC.md](SPEC.md) for the full specification and the roadmap below.

## Requirements

- Immich **v3.2 or newer** on every server (tested with v3.2.4 and v3.3.x). When source and target run different versions, the app warns before a step runs.
- To run it: Docker with Compose.
- To develop it: [Bun](https://bun.sh) 1.4+ and Docker (for the development database).

## Run with Docker Compose

```bash
cp .env.example .env
# fill in POSTGRES_PASSWORD, ADMIN_PASSWORD and SECRET_KEY (openssl rand -hex 32)
docker compose up -d --build
```

Then open http://localhost:8080.

- The app listens on **localhost only** by default (`127.0.0.1:8080`). It holds API keys that can trash photos, so put it behind a reverse proxy with HTTPS before exposing it on a network.
- PostgreSQL data lives in `./postgres`. No photos are stored by the app: originals are streamed from one Immich server to the other.

## Develop

```bash
bun install
cp .env.example .env        # fill in ADMIN_PASSWORD and SECRET_KEY; DATABASE_URL already points at the dev database
bun run db:up               # PostgreSQL 17 on localhost:5432 (docker-compose.dev.yml)
bun run dev                 # backend on :8080 (auto-reload) + frontend on :5173 (proxies /api)
```

Open http://localhost:5173.

| Command | What it does |
| --- | --- |
| `bun test` | All tests. Database tests run only when `TEST_DATABASE_URL` is set, e.g. `TEST_DATABASE_URL=postgres://immich_sync:devpassword@localhost:5432/immich_sync bun test` |
| `bun run typecheck` | TypeScript in every package, `svelte-check` for the frontend |
| `bun run build` | Builds the frontend into `frontend/dist` |
| `bun run start` | Runs the backend (serves `frontend/dist` when `STATIC_DIR` is set) |
| `bun run db:down` | Stops the development database |

## Layout

| Folder | Contents |
| --- | --- |
| `core/` | Pure TypeScript on the official `@immich/sdk`: instance checks, read-only copy/move preview, streamed copy execution with target checksum verification, and partial metadata-field sync for explicitly selected assets, including optional additive album membership; complete metadata sync and move/source-trash execution remain future work. |
| `backend/` | Bun HTTP server: `/api/*`, PostgreSQL via `Bun.sql`, SQL migrations in `src/db/migrations`, serves the built frontend. |
| `frontend/` | Svelte 5 + Vite + Skeleton (Tailwind 4) single-page app. |
| `SPEC.md` | What the app does and why. |

## Roadmap

1. **Engine** (`core`, in progress): read-only preview, streamed copy with target checksum verification, and selected-asset partial metadata-field sync (including opt-in additive album membership) are implemented. Next: remaining metadata synchronization and verify-before-trash move execution, with the Python script's safety scenarios ported as tests against a fake Immich server.
2. **Backend**: login, instances API (encrypted keys, Test connection), jobs, job runner with locks, live logs over SSE, history, scheduler.
3. **Frontend**: Run form with dry run, console, Instances, Jobs and batch editor, History, Dashboard.
4. **Release**: multi-arch image (amd64, arm64) on GHCR, docs.

## License

Not chosen yet. Note that `@immich/sdk` is licensed AGPL-3.0, which matters for how this project is licensed and distributed.
