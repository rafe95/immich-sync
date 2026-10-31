# Svelte Flow UI: instance map, job pipeline, live run diagram

Date: 2026-10-31 · Status: approved direction, ready for planning
Mocks: Design canvas "Immich Sync flow UI mocks" (artboards A, B, C), private to the owner.

## Intent

The frontend works but reads as a set of forms and tables. Users of Immich Sync think in terms of
servers and the flows of photos between them, so the UI should show that directly:

- **A · Dashboard instance map:** what instances exist, how jobs connect them, what is running now, what needs attention.
- **B · Job pipeline editor:** a job's ordered steps drawn as a pipeline instead of a form list.
- **C · Live run diagram:** a run's progress as a row of step boxes above the console.

[Svelte Flow](https://svelteflow.dev/) (`@xyflow/svelte`) draws the three diagrams. Everything around
them uses Skeleton (already installed, Cerberus theme) and its tokens.

## Goals

- All three screens in this stage.
- Diagrams are views over data the frontend already gets; no new data model.
- Look consistent with the rest of the app: Skeleton classes/components and theme tokens, light and dark mode.
- Keep every safety rule visible where it matters (verify-before-trash for move, scheduled-move confirmation, target-trash skips, write locks).

## Non-goals (this stage)

- Creating or editing jobs from the dashboard map; jobs are still made in the Jobs screen. The only changes the map allows are instance management through its side panel (A2).
- A dedicated mobile layout. On small screens the diagrams pan/zoom inside their box; a proper mobile treatment is a later stage.
- Backend changes, unless a builder finds data that truly cannot be derived (then it is a small, separate change with tests).
- Other navigation changes (only the Instances tab is removed).

## Anti-goals

- A diagram that lets the user start, cancel or change something by an accidental drag. Only explicit buttons act, and they go through the existing API calls and confirmations.
- Branching or parallel steps in the pipeline. Steps remain a strict ordered list, matching the backend.
- Direct Immich traffic or credentials in the browser (unchanged rule).
- Describing planned behaviour as existing in `README.md`.

## Constraints

- Svelte 5 + Vite + Skeleton 5 (Tailwind 4); follow existing runes patterns.
- `@xyflow/svelte` 1.7.0 (peer `svelte ^5.25.0`; the app has 5.57.2). Pin the exact version like the other deps.
- Pure logic lives in `src/lib/*.ts` with `bun test` unit tests, as today (graph building, layout, status mapping are all pure and testable).
- Colours come from theme tokens, not hex: copy = `primary`, move = `warning`, sync metadata = `tertiary` (or `secondary`, builder's call against the theme). Health: `success` / `warning` / `error`.

## Decided behaviour

### Shared foundation (must land first)

- Add `@xyflow/svelte` and its stylesheet; a small wrapper (`src/lib/flow/` or `src/flow/`) that sets theme-aware background dots, controls (zoom, fit view; lock only on the map), minimap where used, and fit-on-load.
- Shared pieces used by all screens: operation → colour/label/icon mapping, an **instance node** (alias, default tag, version, last checked, health dot, optional activity badge; no asset count, since no API returns one — *design call*), a **step node** (number, operation, source → target, option chips, status), and the edge styles (solid, animated dashed for running, muted dashed for drafts/unscheduled).
- Nodes are our own Svelte components styled with Skeleton (`card`, `badge preset-tonal-*`).

### A · Dashboard instance map (read-only)

- Nodes: one per instance from `/api/dashboard` (`instances`, health via the existing `instanceHealth`).
- Edges: one per job step, from `api.listJobs()` (steps carry `sourceId`/`targetId`). Label: job name plus next scheduled time or last result. Take the schedule from each job's own `schedule` (`enabled`, `nextRuns`, `moveConfirmedAt`), not from the dashboard's `nextScheduled` (capped at 5 and omits unconfirmed moves); take the last result from `api.listRuns({ jobId, limit: 1 })` per job, as `Jobs.svelte` already does (*design call*: frontend only). Drawing: no schedule → muted, "not scheduled"; schedule disabled → muted, "paused"; scheduled move not confirmed → warning style, "move not confirmed" (a safety state, never hidden).
- Multi-step jobs: one edge per step; selecting any edge selects the whole job (all its edges highlighted).
- Running: for each entry in `running`, fetch the run (`api.getRun`) to get `settings.jobId` and `settings.steps` (add `jobId` to the frontend `Run.settings` type; the backend already stores it). The current step's edge is animated with its percentage; the target node shows "Write lock · <job>", the source "Reading for <job>". An ad-hoc run (no job) draws a temporary edge for its current step. Queued runs (`api.listRuns({ status: "queued" })`, since the dashboard's `running` has only running runs) draw their first step's edge muted-dashed with "waiting for lock" (*design call*).
- Selection panel (Skeleton side panel/drawer): instance → health check result, "Check now" (existing `checkInstance`), link to Instances. Job edge → if running, progress, counts, short live log (run SSE) and "Open run" / "Cancel run" (cancel behind a confirm dialog); otherwise job summary with "Open job" and "Dry run".
- Layout: automatic left-to-right (instances that are only sources on the left, only targets on the right, both in between). Users may drag nodes; positions are saved per browser in `localStorage` (wrapped in try/catch), never in the database. "Reset layout" restores the automatic one.
- Refresh: keep the existing cadence (15 s while running, 60 s otherwise, paused when hidden). The selected running job also listens to its run's event stream.
- The existing summary cards (instances, running, next scheduled, last 7 days) stay above the map; the recent-runs list may stay below it.

### A2 · Instance management on the dashboard (mock D)

- The separate Instances screen and its nav tab go away; instances are managed from the map. Depends on the per-user ownership change: the map shows only the signed-in user's instances.
- Map toolbar: "+ Add instance", "Check all", and a Map / List switch. List is the current instance table (keyboard-friendly, many instances, small screens). A dashed "Add instance" placeholder node also sits on the map.
- Instances no job uses still appear as nodes.
- Selecting an instance opens its panel: jobs that use it; connection check as four stages (ping, version, key, permissions) with "Check now"; the edit form (alias, API URL, API key — never shown, blank keeps the stored key —, note, default) with "Save and check" and "Delete…". Delete confirms and lists the jobs that use it.
- Changes happen only through this form and its buttons, never by dragging; jobs are still created in the Jobs screen.
- Track A owns `Instances.svelte` (reused for the panel and list) and the `App.svelte` nav change.

### B · Job pipeline editor

- Replaces the step list inside `JobEditor.svelte`; the job's name and save keep their current behaviour (run, dry-run and the move-confirmation dialog live in `Jobs.svelte` and are unchanged).
- Vertical pipeline: schedule node on top when the job has one (cron, time zone, next run, catch-up). The schedule node is **read-only** (owner decision); its "Edit schedule" button opens the existing `ScheduleEditor.svelte`, and run / dry-run / move confirmation stay in `Jobs.svelte`, so track B stays inside `JobEditor.svelte`, then one step node per step, then "+ Add step". The edge after each step is labelled with its `onFailure` choice (some assets failed: stop / continue); `onError` (the step could not run) shows as a small icon with a tooltip on the same edge, and only when it differs from `onFailure` (*design call*).
- Selecting a step opens the existing step fields in a side panel rebuilt with Skeleton: `SegmentedControl` (operation), `Switch` (metadata, albums, create missing albums, tags, include trashed — disabled for move with a note), source/target pickers, range, kind, on failure.
- Validation reuses `validateStep` / `normalizeStepForm` from `lib/jobs.ts`; problems show as a badge on the node and in a "Checks" list (including same source/target, unsupported instance versions from the last check, and an unconfirmed scheduled move).
- Adding: a palette (Copy / Move / Sync metadata) and "+ Add step"; dropping between two steps inserts there. Duplicate uses `duplicateStep`, reorder by dragging a node vertically uses `moveItem`, delete from the panel. Max steps stays `MAX_STEPS`.
- Move steps show "Verify before trash" on the node; a scheduled job with an unconfirmed move shows a warning on the schedule node pointing to "Edit schedule", where the existing confirmation lives.

### C · Live run diagram

- Added above the console in `RunView.svelte`; the console stays.
- Horizontal row: preflight node (locks taken, then instances checked — the backend's order), then one node per step from `run.settings.steps`, state from `run.steps[].status` and live events. There is no typed preflight event, so its state is inferred (*design call*): passed once the first step starts; failed if the run ends before any step started; otherwise in progress (or "waiting for lock" while the run is `queued`).
- Step status mapping from the backend: `pending` → waiting; `running` → running (circular progress + phase); `completed` → done; `completed_with_failures` → done with a warning badge and failure count; `error` → failed; `cancelled` → cancelled; `not_run` → not run (muted). Edges turn solid when the previous step completed, animated while the next runs.
- Driven by the same event stream as the console. Today `Console.svelte` opens its own `EventSource` and keeps its state internally, so track C first lifts that state into `RunView.svelte` (or a small store in `lib/runs.ts`) and passes it to both the console and the diagram; reconnect/resume stays in one place. This is a real refactor within track C's files. Per-step progress uses events whose `data.step` matches the step position; if a progress event has no step, it applies to the step currently running.
- Clicking a step filters the console to that step and shows its counts and failed assets (existing `failures` / step summaries in `lib/runs.ts`).
- The same view works for finished runs opened from History.

## Parallel work

After the shared foundation is merged, three tracks can run at once on separate branches, each in its own files:

| Track | Files |
| --- | --- |
| A · Map + instances | `Dashboard.svelte`, `lib/dashboard.ts` (+ tests), `Instances.svelte`, `App.svelte` (nav), new map components |
| B · Pipeline | `JobEditor.svelte`, `lib/jobs.ts` (+ tests), new pipeline components |
| C · Run diagram | `RunView.svelte`, `Console.svelte`, `lib/runs.ts` (+ tests), new run-diagram components |

Shared files (foundation components, `package.json`, `app.css`) are owned by the foundation step; a track that needs a change there asks for it rather than editing it. The `Run.settings.jobId` type addition in `lib/runs.ts` belongs to track C; track A may add it too if C has not landed, and the merge is trivial.

## Left to the builder

- Exact component file names and folder.
- The automatic layout algorithm (hand-rolled columns are fine; a layout library only if needed and pinned).
- Which Skeleton component hosts the side panels (drawer `Dialog`, `FloatingPanel`, or a plain aside).
- The sync-metadata token (`tertiary` vs `secondary`) and icon set (inline stroke SVG like the mocks is fine).
- Whether the minimap appears on B and C.

## Done when

- The three screens behave as described, in light and dark mode, with no regressions in existing flows.
- New pure helpers have unit tests; `bun test`, `bun run typecheck` and `bun run build` pass.
- `README.md` describes the new screens as implemented, and only what is implemented.
