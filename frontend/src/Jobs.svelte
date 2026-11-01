<script lang="ts">
  import { onMount } from "svelte";
  import JobEditor from "./JobEditor.svelte";
  import ScheduleEditor from "./ScheduleEditor.svelte";
  import { ApiError, type Instance } from "./lib/api.ts";
  import { formatWhen, scheduleSummary, stepSummary, type JobRecord, type ScheduleRecord } from "./lib/jobs.ts";
  import { statusClass, statusLabel, type Run, type RunStatus } from "./lib/runs.ts";
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
  let deleteDialog = $state<HTMLDialogElement | null>(null);
  let runDialog = $state<HTMLDialogElement | null>(null);

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
      runDialog?.showModal();
    } else void start(job, false);
  }

  async function doDelete() {
    const job = confirmDelete;
    deleteDialog?.close();
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
  <h1 class="h3">Jobs</h1>

  {#if notice}<p class="text-sm" role="status">{notice}</p>{/if}

  {#if mode.kind === "edit"}
    <JobEditor job={mode.job} {instances} onsaved={saved} oncancel={() => (mode = { kind: "list" })} oneditschedule={editSchedule} />
  {:else if mode.kind === "schedule" && editingSchedule}
    <ScheduleEditor job={editingSchedule} onsaved={(s) => scheduleSaved(editingSchedule.id, s)} onclose={() => { mode = { kind: "list" }; void load(); }} />
  {:else if loading}
    <p role="status">Loading jobs…</p>
  {:else if loadError}
    <p class="text-error-500" role="alert">Could not load jobs: {loadError}</p>
    <button type="button" class="btn preset-tonal-surface" onclick={load}>Retry</button>
  {:else}
    <div>
      <button type="button" class="btn preset-filled-primary-500" disabled={instances.length < 2} onclick={() => (mode = { kind: "edit", job: null })}>New job</button>
      {#if instances.length < 2}<span class="ml-2 text-sm opacity-70">A job needs two registered instances (add them on the Dashboard).</span>{/if}
    </div>

    {#if jobs.length === 0}
      <p class="opacity-70">No saved jobs yet.</p>
    {:else}
      <ul class="space-y-3">
        {#each jobs as job (job.id)}
          {@const last = lastRuns[job.id]}
          <li class="card preset-outlined-surface-200-800 space-y-2 p-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h2 class="h5">{job.name}</h2>
              <div class="flex flex-wrap items-center gap-2 text-sm">
                {#if job.hasMove}<span class="badge preset-tonal-warning">moves assets</span>{/if}
                {#if last}
                  <span>Last run:</span><span class="badge {statusClass(last.status)}">{statusLabel(last.status)}</span>
                  <span class="opacity-70">{formatWhen(last.finishedAt ?? last.startedAt ?? last.createdAt)}</span>
                {:else}<span class="opacity-70">Never run</span>{/if}
              </div>
            </div>
            <ol class="list-decimal pl-5 text-sm">
              {#each job.steps as s, i (s.id ?? i)}<li>{stepSummary(s, alias)}</li>{/each}
            </ol>
            <p class="text-sm">
              <strong>Schedule:</strong> {scheduleSummary(job.schedule)}
              {#if job.schedule?.enabled && job.schedule.nextRuns.length}
                <span class="block opacity-80">Next: {job.schedule.nextRuns.map((r) => formatWhen(r, job.schedule!.timezone)).join(" · ")}</span>
              {/if}
            </p>
            <div class="flex flex-wrap gap-2">
              <button type="button" class="btn btn-sm preset-filled-primary-500" disabled={busyId === job.id} onclick={() => runNow(job)}>Run now</button>
              <button type="button" class="btn btn-sm preset-tonal-primary" disabled={busyId === job.id} onclick={() => start(job, true)}>Dry run</button>
              <button type="button" class="btn btn-sm preset-tonal-surface" onclick={() => (mode = { kind: "edit", job })}>Edit<span class="sr-only"> {job.name}</span></button>
              <button type="button" class="btn btn-sm preset-tonal-surface" onclick={() => (mode = { kind: "schedule", jobId: job.id })}>Schedule<span class="sr-only"> for {job.name}</span></button>
              <button type="button" class="btn btn-sm preset-tonal-error" disabled={busyId === job.id} onclick={() => { confirmDelete = job; deleteDialog?.showModal(); }}>Delete<span class="sr-only"> {job.name}</span></button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  <dialog bind:this={deleteDialog} class="card preset-filled-surface-100-900 m-auto max-w-lg space-y-3 p-5 backdrop:bg-black/50" aria-labelledby="del-title">
    <h2 id="del-title" class="h5">Delete "{confirmDelete?.name}"?</h2>
    <p>The job and its schedule are removed. Past runs stay in History. No assets are touched.</p>
    <div class="flex flex-wrap justify-end gap-2">
      <button type="button" class="btn preset-tonal-surface" onclick={() => deleteDialog?.close()}>Cancel</button>
      <button type="button" class="btn preset-filled-error-500" onclick={doDelete}>Delete job</button>
    </div>
  </dialog>

  <dialog bind:this={runDialog} class="card preset-filled-surface-100-900 m-auto max-w-lg space-y-3 p-5 backdrop:bg-black/50" aria-labelledby="run-title">
    <h2 id="run-title" class="h5">Run "{confirmRun?.name}" for real?</h2>
    <p>This job moves assets. Each is verified on its target first, then sent to the source server's trash. Nothing is permanently deleted. Consider a dry run first.</p>
    <div class="flex flex-wrap justify-end gap-2">
      <button type="button" class="btn preset-tonal-surface" onclick={() => runDialog?.close()}>Cancel</button>
      <button type="button" class="btn preset-filled-error-500" onclick={() => { const j = confirmRun; runDialog?.close(); if (j) void start(j, false); }}>Run and trash after verification</button>
    </div>
  </dialog>
</div>
