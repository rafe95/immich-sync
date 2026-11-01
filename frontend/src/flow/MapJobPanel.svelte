<script lang="ts">
  import { api } from "../lib/session.svelte.ts";
  import type { RunEvents } from "../lib/runEvents.svelte.ts";
  import { countsText, recentLines } from "../lib/flow/live.ts";
  import type { MapInput } from "../lib/flow/map.ts";
  import type { JobRecord } from "../lib/jobs.ts";
  import { progressPercent, statusLabel } from "../lib/runs.ts";

  let {
    job,
    map,
    onopenrun,
    onopenjob,
    eventsFor,
    onchanged,
    onclose,
  }: {
    job: JobRecord;
    map: MapInput;
    onopenrun?: (runId: string) => void;
    onopenjob?: (jobId: string) => void;
    /** The live event stream of a running run, when there is one. */
    eventsFor?: (runId: string) => RunEvents | undefined;
    onchanged: () => void;
    onclose: () => void;
  } = $props();

  const active = $derived(map.active.find((a) => a.run.settings.jobId === job.id) ?? null);
  const last = $derived(map.lastResults[job.id] ?? null);
  const stream = $derived(active && !active.queued ? eventsFor?.(active.run.id) : undefined);
  const cs = $derived(stream?.state ?? null);
  const percent = $derived(progressPercent(cs?.progress ?? null));
  const lines = $derived(cs ? recentLines(cs.events, 4) : []);
  let busy = $state(false);
  let confirmCancel = $state(false);
  let error = $state<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    busy = true;
    error = null;
    try {
      await fn();
      onchanged();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      confirmCancel = false;
    }
  }
</script>

<aside class="card preset-outlined-surface-200-800 space-y-3 p-4" aria-label="Job details">
  <div class="flex items-start justify-between gap-2">
    <h3 class="h6">{job.name}</h3>
    <button type="button" class="btn btn-sm preset-tonal-surface" onclick={onclose}>Close</button>
  </div>
  <p class="text-sm">{job.steps.length} step{job.steps.length === 1 ? "" : "s"}{job.schedule ? (job.schedule.enabled ? ", scheduled" : ", schedule paused") : ", not scheduled"}</p>
  {#if active}
    <p><span class="badge preset-tonal-primary">{active.queued ? "waiting for lock" : "running"}</span></p>
    {#if cs}
      <div class="space-y-1 text-sm">
        {#if cs.progress}
          <div class="flex justify-between gap-2">
            <span>{cs.progress.label ?? "Progress"}</span>
            <span>{cs.progress.done}{cs.progress.total !== null ? ` / ${cs.progress.total}` : ""}{percent !== null ? ` (${percent}%)` : ""}</span>
          </div>
          <progress class="h-2 w-full" max={cs.progress.total ?? undefined} value={cs.progress.total ? cs.progress.done : undefined} aria-label="Run progress"></progress>
        {/if}
        <p class="opacity-80">{countsText(cs.counts)}</p>
        {#if lines.length}
          <ul class="space-y-0.5 font-mono text-xs opacity-80" aria-label="Recent log lines">
            {#each lines as line, i (i)}<li class="truncate" title={line}>{line}</li>{/each}
          </ul>
        {/if}
      </div>
    {/if}
    <div class="flex flex-wrap gap-2">
      {#if onopenrun}<button type="button" class="btn btn-sm preset-filled-primary-500" onclick={() => onopenrun(active.run.id)}>Open run</button>{/if}
      {#if onopenjob}<button type="button" class="btn btn-sm preset-tonal-surface" onclick={() => onopenjob(job.id)}>Open job</button>{/if}
      {#if confirmCancel}
        <button type="button" class="btn btn-sm preset-filled-error-500" disabled={busy} onclick={() => act(() => api.cancelRun(active.run.id))}>Confirm cancel</button>
        <button type="button" class="btn btn-sm preset-tonal-surface" onclick={() => (confirmCancel = false)}>Keep running</button>
      {:else}
        <button type="button" class="btn btn-sm preset-tonal-error" onclick={() => (confirmCancel = true)}>Cancel run</button>
      {/if}
    </div>
  {:else}
    <p class="text-sm opacity-70">{last ? `Last run: ${statusLabel(last.status)}` : "Never run."}</p>
    <div class="flex flex-wrap gap-2">
      {#if onopenjob}<button type="button" class="btn btn-sm preset-filled-primary-500" onclick={() => onopenjob(job.id)}>Open job</button>{/if}
      <button type="button" class="btn btn-sm preset-tonal-primary" disabled={busy} onclick={() => act(() => api.runJob(job.id, true))}>Dry run</button>
    </div>
  {/if}
  {#if error}<p class="text-sm text-error-500" role="alert">{error}</p>{/if}
</aside>
