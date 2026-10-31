# Svelte Flow UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dashboard instance map with instance management, a pipeline job editor, and a live run diagram, drawn with Svelte Flow inside the existing Skeleton UI.

**Architecture:** All graph shaping (nodes, edges, layout, status mapping) is pure TypeScript in `frontend/src/lib/flow/*.ts` with `bun test` tests; Svelte components only render what those functions return. Svelte Flow (`@xyflow/svelte`) renders the canvases; panels and forms use Skeleton components and theme tokens. After Task F, tracks A, B and C touch disjoint files and can run in parallel on separate branches.

**Tech Stack:** Svelte 5 (runes), Vite, Skeleton 5 / Tailwind 4 (Cerberus theme), `@xyflow/svelte` 1.7.0, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-31-svelte-flow-ui-design.md` (mocks: Design canvas "Immich Sync flow UI mocks", artboards A–D).

**Depends on:** `docs/superpowers/plans/2026-10-31-per-user-ownership.md` merged first (all lists are already the caller's own data).

## Global Constraints

- `@xyflow/svelte` pinned to exactly `1.7.0` in `frontend/package.json` devDependencies, like the other deps.
- Colours only from theme tokens: copy = `primary`, move = `warning`, sync metadata = `tertiary`; health ok/warn/error = `success`/`warning`/`error`. No hex in components.
- Must work in light and dark mode (Skeleton `*-50-950` pairs / `surface-*` tokens).
- Browser never talks to Immich and never sees API keys (API key input is write-only; blank keeps the stored key).
- Nothing on a canvas changes data by dragging. Data changes only through panel forms and buttons using the existing `api.*` calls and existing confirmations.
- No mobile layout work; canvases pan/zoom inside their box.
- `localStorage` access wrapped in try/catch; the app renders without it.
- Docs describe only implemented behaviour.

## Review Focus

1. **Instance referenced by a job whose step points at a deleted/unknown instance id** — map must not crash; draw the edge to a placeholder "Unknown instance" node. Test in Task A1.
2. **Run event stream reconnect while the diagram is shown** — diagram and console show the same state after resume (one shared state). Test in Task C1.
3. **Saved layout in `localStorage` referencing instances that no longer exist, or missing new ones** — stale ids ignored, new instances get auto positions. Test in Task A1.
4. **Job with zero steps / new unsaved job** in the pipeline — renders only "+ Add step" (and no schedule node). Test in Task B1.
5. **Progress events without `data.step`** — applied to the currently running step, not dropped. Test in Task C2.

---

### Task F: Shared flow foundation

**Files:**
- Modify: `frontend/package.json`, `frontend/src/app.css` (import `@xyflow/svelte/dist/style.css` and theme overrides for `.svelte-flow` background/controls/minimap using Skeleton tokens)
- Create: `frontend/src/lib/flow/ops.ts`, `frontend/src/lib/flow/ops.test.ts`
- Create: `frontend/src/flow/FlowCanvas.svelte`, `frontend/src/flow/InstanceNode.svelte`, `frontend/src/flow/StepNode.svelte`, `frontend/src/flow/LabelEdge.svelte`

**Interfaces:**
- Produces (`lib/flow/ops.ts`):
  - `type OpTone = "primary" | "warning" | "tertiary"`; `opTone(op: Operation): OpTone`; `opLabel` re-exported from `OP_LABEL`.
  - `type EdgeStyle = "solid" | "running" | "muted" | "warning"`.
  - `type InstanceNodeData = { alias: string; isDefault: boolean; version: string | null; checkedAt: string | null; health: Health; activity: { kind: "lock" | "reading" | "waiting"; job: string } | null; selected?: boolean }` (`Health` from `lib/dashboard.ts`).
  - `type StepNodeData = { position: number; operation: Operation; source: string; target: string; chips: string[]; status: StepVisualStatus; percent: number | null; problems: string[] }`; `type StepVisualStatus = "idle" | "waiting" | "running" | "done" | "done_with_failures" | "failed" | "cancelled" | "not_run"`.
  - `type LabelEdgeData = { label: string; tone: OpTone | "neutral"; style: EdgeStyle; icon?: "on-error" }`.
- Components: `FlowCanvas` props `{ nodes, edges, nodeTypes?, minimap?: boolean, lockable?: boolean, onnodeclick?, onedgeclick?, onnodedragstop? }` wrapping `SvelteFlow` + `Background` (dots) + `Controls` (+ optional `MiniMap`) with `fitView`. Node/edge components render their `data` with Skeleton classes (`card`, `badge preset-tonal-*`). `InstanceNode` has left/right handles; `StepNode` reads `data.orientation: "vertical" | "horizontal"` (add it to `StepNodeData`) and puts handles top/bottom or left/right accordingly.

- [ ] **Step 1: Write failing tests** in `ops.test.ts`: `opTone("copy") === "primary"`, `opTone("move") === "warning"`, `opTone("sync_metadata") === "tertiary"`.
- [ ] **Step 2: Run** `bun test frontend/src/lib/flow/ops.test.ts` — FAIL.
- [ ] **Step 3: Install** `@xyflow/svelte@1.7.0` (`bun add -d --exact @xyflow/svelte@1.7.0` in `frontend/`), implement `ops.ts` and the four components.
- [ ] **Step 4: Run** `bun test`, `bun run typecheck`, `bun run build` — PASS.
- [ ] **Step 5: Commit** `git commit -am "Add Svelte Flow and shared flow nodes"` (include new files).

*Tracks A, B, C start after Task F is merged. Each track owns only its listed files; a needed change to Task F's files is requested, not made.*

### Task A1: Map graph model (track A)

**Files:**
- Create: `frontend/src/lib/flow/map.ts`, `frontend/src/lib/flow/map.test.ts`

**Interfaces:**
- Consumes: `DashboardResponse` (`lib/dashboard.ts`), `JobRecord` (`lib/jobs.ts`), `Run` (`lib/runs.ts`, add `jobId: string | null` to `Run.settings` here if track C has not), `Instance` (`lib/api.ts`).
- Produces:
  - `type MapInput = { instances: Instance[]; jobs: JobRecord[]; lastResults: Record<string, { status: RunStatus; finishedAt: string | null } | null>; active: Array<{ run: Run; percent: number | null; queued: boolean }> }`.
  - `buildMap(input: MapInput): { nodes: Node<InstanceNodeData>[]; edges: Edge<LabelEdgeData>[] }` — one node per instance (+ `unknown:<id>` placeholder nodes for dangling step ids); one edge per job step, id `${jobId}:${position}`, `data.jobId` for whole-job selection.
  - Edge label/style rules: running step → `running`, label `"<job> · <n>%"`; queued run's first step → `muted`, `"<job> · waiting for lock"`; schedule enabled + move + `moveConfirmedAt === null` → `warning`, `"<job> · move not confirmed"`; schedule enabled → `solid`, `"<job> · <next run, formatWhen>"`; schedule disabled → `muted`, `"<job> · paused"`; no schedule → `muted`, `"<job> · not scheduled"`; otherwise append last result.
  - Activity badges: running/queued run's current step target → `{ kind: "lock" }`, source → `{ kind: "reading" }`; queued → `{ kind: "waiting" }`.
  - `autoLayout(nodes, edges): Record<string, { x: number; y: number }>` — columns: only-source = 0, both = 1, only-target = 2, unconnected = column 0 below; 320 px column gap, 180 px row gap.
  - `mergeLayout(auto, saved: Record<string, {x:number;y:number}> | null)` — saved wins for existing ids, stale ids dropped.
  - `loadLayout(): Record<…> | null` / `saveLayout(pos)` using key `immich-sync.map-layout.v1`, try/catch.

- [ ] **Step 1: Write failing tests:** edge per step with correct ids; each label/style rule above (one test each, exact strings); activity badges; dangling instance id → placeholder node (Review Focus 1); `autoLayout` columns; `mergeLayout` drops stale and keeps new auto (Review Focus 3); `loadLayout` returns null when `localStorage` throws.
- [ ] **Step 2: Run** `bun test frontend/src/lib/flow/map.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -am "Build the instance map graph"`

### Task A2: Dashboard map with selection panel (track A)

**Files:**
- Modify: `frontend/src/Dashboard.svelte`, `frontend/src/lib/dashboard.ts` (+ `dashboard.test.ts`)
- Create: `frontend/src/flow/InstanceMap.svelte`, `frontend/src/flow/MapJobPanel.svelte`

**Interfaces:**
- Consumes: `buildMap`, `autoLayout`, `mergeLayout`, `loadLayout`, `saveLayout` (A1); `FlowCanvas` (F).
- Produces: `loadMapInput(api): Promise<{ dashboard: DashboardResponse; map: MapInput }>` in `lib/dashboard.ts` — `api.request<DashboardResponse>("GET", "/api/dashboard")` (as `Dashboard.svelte` does today), `api.listInstances()`, `api.listJobs()`, `api.listRuns({ limit: 1, offset: 0, jobId })` per job, `api.getRun(id)` per `running` entry, `api.listRuns({ limit: 20, offset: 0, status: "queued" })`.
- Behaviour: keep summary cards; map below them; existing refresh cadence (`refreshInterval`). Clicking an edge selects all edges with the same `data.jobId` and opens `MapJobPanel`: running → progress (`progressPercent` from the run's SSE via the existing `Console` reducer helpers), counts, last 4 log lines, "Open run" (`onopenrun`), "Cancel run" behind a Skeleton `Dialog`; not running → summary, "Open job", "Dry run" (`api.runJob(id, true)`). Toolbar "Reset layout" clears saved layout. Node drag stop → `saveLayout`.

- [ ] **Step 1: Write failing test** for `loadMapInput` with a fake api object: calls `listRuns` once per job with `limit: 1`, maps results by job id, includes queued runs with `queued: true`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** helper and components.
- [ ] **Step 4: Run** `bun test`, `bun run typecheck`, `bun run build` — PASS; manual check in `bun run dev` against the fake data you can create locally (two instances, one job).
- [ ] **Step 5: Commit** `git commit -am "Show instances and jobs as a map on the dashboard"`

### Task A3: Instance management on the dashboard (track A)

**Files:**
- Modify: `frontend/src/Instances.svelte` (split), `frontend/src/App.svelte` (remove Instances tab), `frontend/src/Dashboard.svelte`
- Create: `frontend/src/InstanceForm.svelte`, `frontend/src/InstanceList.svelte`, `frontend/src/flow/MapInstancePanel.svelte`
- Test: `frontend/src/lib/dashboard.test.ts` (or a new `lib/instances.ts` + test if logic moves)

**Interfaces:**
- `InstanceForm` props `{ instance: Instance | null; onsaved: (i: Instance) => void; ondeleted?: (id: string) => void; oncancel: () => void }` — the existing form fields and logic from `Instances.svelte` (alias, API URL, API key write-only, note, default), "Save and check" (save then `api.checkInstance`), "Delete…" with the existing confirm, listing jobs that use it (`jobsUsing(instanceId, jobs): JobRecord[]`, pure, tested).
- `InstanceList` = the current instances table (Map / List switch in the map toolbar uses Skeleton `SegmentedControl`).
- `MapInstancePanel` = jobs using it, check stages (`ping`, `version`, `key`, `permissions`) with "Check now", then `InstanceForm`.
- Map toolbar: "+ Add instance" (opens panel with `instance: null`), "Check all" (sequential `checkInstance` per instance), placeholder "Add instance" node.

- [ ] **Step 1: Write failing test** `jobsUsing` returns jobs whose any step has the id as source or target, each job once.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; remove the `instances` screen entry from `App.svelte`'s `screens`.
- [ ] **Step 4: Run** `bun test`, typecheck, build — PASS; manual: add, edit (blank key keeps key), check, delete an instance from the dashboard.
- [ ] **Step 5: Commit** `git commit -am "Manage instances from the dashboard map"`

### Task B1: Pipeline graph model (track B)

**Files:**
- Create: `frontend/src/lib/flow/pipeline.ts`, `frontend/src/lib/flow/pipeline.test.ts`

**Interfaces:**
- Consumes: `StepForm`, `validateStep`, `normalizeStepForm`, `moveItem`, `OP_LABEL`, `scheduleSummary`, `needsMoveConfirmation` (`lib/jobs.ts`); `Instance` with `lastCheck`.
- Produces:
  - `buildPipeline(input: { steps: StepForm[]; schedule: ScheduleRecord | null; instances: Instance[]; selectedKey: string | null }): { nodes: Node[]; edges: Edge<LabelEdgeData>[] }` — optional `schedule` node, one `StepNode` per step (vertical, x fixed, y = index × 170), an `add` node last. Edge after step i labelled `"on failure · stop job"` or `"on failure · continue"` from `onFailure`; `icon: "on-error"` only when `onError !== onFailure`.
  - `stepProblems(step, index, instances): string[]` = `validateStep` plus `"<alias> runs an unsupported Immich version"` for source/target whose `lastCheck.versionStatus === "unsupported"`.
  - `scheduleWarning(schedule, steps): string | null` → `"Scheduled move not confirmed"` when `needsMoveConfirmation(steps, schedule.enabled) && !schedule.moveConfirmedAt`.
  - `dropIndex(y: number, count: number): number` — insertion index for a palette drop at canvas y (round to nearest gap, clamped `0..count`).
  - `reorderByY(steps, key, y): StepForm[]` using `moveItem`.

- [ ] **Step 1: Write failing tests:** zero steps → only `add` node, no schedule node when `schedule === null` (Review Focus 4); edge labels exact strings; on-error icon rule; unsupported-version problem; schedule warning; `dropIndex` bounds; `reorderByY` moves step 0 below step 1.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -am "Build the job pipeline graph"`

### Task B2: Pipeline editor (track B)

**Files:**
- Modify: `frontend/src/JobEditor.svelte`, `frontend/src/Jobs.svelte` (pass one new prop only)
- Create: `frontend/src/flow/JobPipeline.svelte`, `frontend/src/flow/StepPanel.svelte`

**Interfaces:**
- Consumes: B1 functions; `FlowCanvas`, `StepNode`, `LabelEdge` (F).
- `JobEditor` gains prop `oneditschedule?: () => void`; `Jobs.svelte` passes a callback opening its existing `ScheduleEditor` for that job. Nothing else in `Jobs.svelte` changes.
- Layout: palette (Copy / Move / Sync metadata, draggable + click-to-append) | pipeline canvas | `StepPanel` for the selected step. `StepPanel` holds the existing step fields rebuilt with Skeleton `SegmentedControl` (operation), `Switch` (metadata, albums, create missing albums, tags, include trashed — disabled for move with note "Not available for move"), selects for source/target/range/kind/on failure/on error, "Duplicate" (`duplicateStep`) and "Remove". Checks card lists all `stepProblems` + `scheduleWarning`. Schedule node is read-only with "Edit schedule" → `oneditschedule`. Save keeps using `buildJobBody`.

- [ ] **Step 1: Run** existing `bun test frontend/src/lib/jobs.test.ts` — PASS (baseline; behaviour logic stays in `lib/jobs.ts`).
- [ ] **Step 2: Implement** components and wire `JobEditor`.
- [ ] **Step 3: Run** `bun test`, typecheck, build — PASS; manual: create a 3-step job via palette, reorder by drag, edit a step, save; open "Edit schedule".
- [ ] **Step 4: Commit** `git commit -am "Edit jobs as a step pipeline"`

### Task C1: One shared run event state (track C)

**Files:**
- Modify: `frontend/src/lib/runs.ts` (+ `runs.test.ts`), `frontend/src/Console.svelte`, `frontend/src/RunView.svelte`
- Create: `frontend/src/lib/runEvents.svelte.ts`

**Interfaces:**
- Produces: `createRunEvents(api, runId: string, mode: "live" | "replay"): { readonly state: ConsoleState; start(): void; stop(): void }` in `lib/runEvents.svelte.ts` — owns the `EventSource`, `reconnectDelay` backoff and resume from `state.lastId`, moved out of `Console.svelte` unchanged in behaviour. `Console.svelte` props become `{ events: { state: ConsoleState }; stepFilter?: number | null }`; `RunView.svelte` creates one instance and passes it to Console (and, in C2, the diagram). Add `jobId: string | null` to `Run.settings` type.
- `stepFilter` filters console lines to events whose `data.step` equals it.

- [ ] **Step 1: Write failing test** in `runs.test.ts`: `reduceEvents` over a sequence split at an arbitrary point (simulated reconnect from `lastId`) yields the same state as the unsplit sequence and drops duplicates with `id <= lastId` (Review Focus 2).
- [ ] **Step 2: Run** — FAIL if duplicate handling is missing; otherwise it documents current behaviour and passes (note which in the commit).
- [ ] **Step 3: Implement** the move.
- [ ] **Step 4: Run** `bun test`, typecheck, build — PASS; manual: live console still streams and resumes after a backend restart.
- [ ] **Step 5: Commit** `git commit -am "Share one run event state between views"`

### Task C2: Live run diagram (track C)

**Files:**
- Create: `frontend/src/lib/flow/run.ts`, `frontend/src/lib/flow/run.test.ts`, `frontend/src/flow/RunDiagram.svelte`
- Modify: `frontend/src/RunView.svelte`

**Interfaces:**
- Consumes: `createRunEvents` state (C1); `StepNode`, `FlowCanvas` (F).
- Produces:
  - `stepVisual(status: string): StepVisualStatus` — `pending→waiting`, `running→running`, `completed→done`, `completed_with_failures→done_with_failures`, `error→failed`, `cancelled→cancelled`, `not_run→not_run`, unknown → `waiting`.
  - `preflightState(run: Run): "waiting_for_lock" | "checking" | "passed" | "failed"` — `queued` → waiting_for_lock; any step not `pending` → passed; run terminal with all steps pending → failed; else checking.
  - `stepPercents(state: ConsoleState, run: Run): Record<number, number | null>` — progress events with `data.step` go to that step; without it to the step whose status is `running` (Review Focus 5).
  - `buildRunGraph(run: Run, state: ConsoleState): { nodes; edges }` — horizontal: `preflight` node then one `StepNode` per `run.settings.steps` (orientation horizontal, x = 40 + i × 290); edge solid once the left node is done/passed, `running` while the right node runs.
- `RunDiagram` above the console; clicking a step sets `stepFilter` and shows its counts and failed assets (existing step summaries / `failures`).

- [ ] **Step 1: Write failing tests:** every `stepVisual` mapping; each `preflightState` case; `stepPercents` with and without `data.step`; `buildRunGraph` node count = steps + 1 and edge styles.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test`, typecheck, build — PASS; manual: live run and a finished run from History both render.
- [ ] **Step 5: Commit** `git commit -am "Show a run as a live step diagram"`

### Task Z: Integration, docs, verification (after all tracks merge)

**Files:**
- Modify: `README.md`, `AGENTS.md` (frontend status lines)

- [ ] **Step 1: Run** `bun test`, `bun run typecheck`, `bun run build` from repo root — PASS.
- [ ] **Step 2: Manual check** in `bun run dev`, light and dark mode: map (selection, live edge, reset layout, instance add/edit/check/delete), pipeline (palette, reorder, checks, edit schedule), run diagram (live + History).
- [ ] **Step 3: Update docs** to describe the three screens and the removed Instances tab as implemented.
- [ ] **Step 4: Commit** `git commit -am "Document the flow-based dashboard, job editor and run view"`
