<script lang="ts">
  import { onMount } from "svelte";
  import JobEditor from "./JobEditor.svelte";
  import ConfirmDialog from "./ui/ConfirmDialog.svelte";
  import ScheduleEditor from "./ScheduleEditor.svelte";
  import { ApiError, type Instance } from "./lib/api.ts";
  import JobCard from "./JobCard.svelte";
  import type { JobRecord, ScheduleRecord } from "./lib/jobs.ts";
  import type { Run } from "./lib/runs.ts";
  import { api } from "./lib/session.svelte.ts";

  let { onrun, openJobId = $bindable(null) }: { onrun: (runId: string) => void; openJobId?: string | null } = $props();

  let jobs = $state<JobRecord[]>([]);
  let instances = $state<Instance[]>([]);
  let lastRuns = $state<Record<string, Run | null>>({});
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let busyId = $state<string | null>(null);
  let mode = $state<{ kind: "list" } | { kind: "edit"; job: JobRecord | null } | { kind: "schedule"; jobId: string }>({ kind: "list" });
  let confirmDelete = $state<JobRecord | null>(null);
  let confirmRun = $state<JobRecord | null>(null);
  let deleteOpen = $state(false);
  let runOpen = $state(false);

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const alias = (id: string) => instances.find((i) => i.id === id)?.alias ?? "unknown instance";

  async function load() {
    try {
      [jobs, instances] = await Promise.all([api.listJobs(), api.listInstances()]);
      loadError = null;
      // Last run per job; a failure here only hides the status.
      const entries = await Promise.all(
        jobs.map(async (j) => [j.id, (await api.listRuns({ limit: 1, offset: 0, jobId: j.id }).catch(() => null))?.runs[0] ?? null] as const),
      );
      lastRuns = Object.fromEntries(entries);
    } catch (e) {
      loadError = msg(e);
    } finally {
      loading = false;
    }
  }
  // "Open job" on the dashboard map lands here with the job to edit.
  onMount(async () => {
    await load();
    const wanted = openJobId;
    openJobId = null;
    const job = wanted ? jobs.find((j) => j.id === wanted) : undefined;
    if (job) mode = { kind: "edit", job };
  });

  async function start(job: JobRecord, dryRun: boolean) {
    busyId = job.id;
    notice = null;
    try {
      const run = await api.runJob(job.id, dryRun);
      onrun(run.id);
    } catch (e) {
      notice = e instanceof ApiError && e.problems.length ? e.problems.join(" ") : msg(e);
    } finally {
      busyId = null;
    }
  }

  /** A real run of a job with a move step asks first; dry runs and copies do not. */
  function runNow(job: JobRecord) {
    if (job.hasMove) {
      confirmRun = job;
      runOpen = true;
    } else void start(job, false);
  }

  async function doDelete() {
    const job = confirmDelete;
    deleteOpen = false;
    if (!job) return;
    busyId = job.id;
    try {
      await api.deleteJob(job.id);
      jobs = jobs.filter((j) => j.id !== job.id);
      notice = `Deleted "${job.name}". Its history is kept.`;
    } catch (e) {
      notice = msg(e);
    } finally {
      busyId = null;
      confirmDelete = null;
    }
  }

  function saved(job: JobRecord) {
    mode = { kind: "list" };
    void load();
    notice = `Saved "${job.name}".`;
  }
  function scheduleSaved(jobId: string, s: ScheduleRecord | null) {
    jobs = jobs.map((j) => (j.id === jobId ? { ...j, schedule: s } : j));
  }

  const editSchedule = $derived.by(() => {
    const m = mode;
    const job = m.kind === "edit" ? m.job : null;
    return job ? () => (mode = { kind: "schedule", jobId: job.id }) : undefined;
  });

  const editingSchedule = $derived.by(() => {
    const m = mode;
    return m.kind === "schedule" ? (jobs.find((j) => j.id === m.jobId) ?? null) : null;
  });
</script>

<div class="space-y-4">
  {#if mode.kind === "list"}
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="h3">Jobs</h1>
        <p class="text-sm opacity-70">Saved pipelines of one to fifty steps, run in order.</p>
      </div>
      {#if !loading && !loadError}
        <div class="flex flex-col items-end gap-1">
          <button type="button" class="btn preset-filled-primary-500" disabled={instances.length < 2} onclick={() => (mode = { kind: "edit", job: null })}>New job</button>
          {#if instances.length < 2}<span class="text-sm opacity-70">A job needs two registered instances (add them on the Dashboard).</span>{/if}
        </div>
      {/if}
    </div>
  {:else if mode.kind === "schedule"}
    <h1 class="sr-only">Jobs</h1>
  {/if}

  {#if notice}<p class="text-sm" role="status">{notice}</p>{/if}

  {#if mode.kind === "edit"}
    <JobEditor job={mode.job} {instances} onsaved={saved} oncancel={() => (mode = { kind: "list" })} oneditschedule={editSchedule} onstart={(j, dry) => (dry ? void start(j, true) : runNow(j))} />
  {:else if mode.kind === "schedule" && editingSchedule}
    <ScheduleEditor job={editingSchedule} onsaved={(s) => scheduleSaved(editingSchedule.id, s)} onclose={() => { mode = { kind: "list" }; void load(); }} />
  {:else if loading}
    <p role="status">Loading jobs…</p>
  {:else if loadError}
    <p class="text-error-500" role="alert">Could not load jobs: {loadError}</p>
    <button type="button" class="btn preset-tonal-surface" onclick={load}>Retry</button>
  {:else}
    {#if jobs.length === 0}
      <p class="opacity-70">No saved jobs yet.</p>
    {:else}
      <ul class="space-y-3">
        {#each jobs as job (job.id)}
          <li>
            <JobCard
              {job}
              last={lastRuns[job.id] ?? null}
              {alias}
              busy={busyId === job.id}
              onrun={() => runNow(job)}
              ondry={() => start(job, true)}
              onedit={() => (mode = { kind: "edit", job })}
              onschedule={() => (mode = { kind: "schedule", jobId: job.id })}
              ondelete={() => { confirmDelete = job; deleteOpen = true; }}
            />
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  <ConfirmDialog
    open={deleteOpen}
    title={`Delete "${confirmDelete?.name}"?`}
    confirmLabel="Delete job"
    tone="danger"
    onconfirm={doDelete}
    oncancel={() => (deleteOpen = false)}
  >
    <p>The job and its schedule are removed. Past runs stay in History. No assets are touched.</p>
  </ConfirmDialog>

  <ConfirmDialog
    open={runOpen}
    title={`Run "${confirmRun?.name}" for real?`}
    confirmLabel="Run and trash after verification"
    tone="danger"
    onconfirm={() => { const j = confirmRun; runOpen = false; if (j) void start(j, false); }}
    oncancel={() => (runOpen = false)}
  >
    <p>This job moves assets. Each is verified on its target first, then sent to the source server's trash. Nothing is permanently deleted. Consider a dry run first.</p>
  </ConfirmDialog>
</div>
