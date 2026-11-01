<script lang="ts">
  import { api } from "../lib/session.svelte.ts";
  import type { RunEvents } from "../lib/runEvents.svelte.ts";
  import { liveTiles, recentLines } from "../lib/flow/live.ts";
  import type { MapInput } from "../lib/flow/map.ts";
  import type { JobRecord } from "../lib/jobs.ts";
  import { operationLabel, progressPercent, statusLabel } from "../lib/runs.ts";

  let {
    job,
    adhocRunId,
    step: stepPosition = 1,
    map,
    onopenrun,
    onopenjob,
    eventsFor,
    onchanged,
    onclose,
  }: {
    /** The saved job, or null for a running ad-hoc run (then `adhocRunId` names it). */
    job: JobRecord | null;
    adhocRunId?: string;
    /** The step (line) that was clicked, 1-based. */
    step?: number;
    map: MapInput;
    onopenrun?: (runId: string) => void;
    onopenjob?: (jobId: string) => void;
    /** The live event stream of a running run, when there is one. */
    eventsFor?: (runId: string) => RunEvents | undefined;
    onchanged: () => void;
    onclose: () => void;
  } = $props();

  const active = $derived(map.active.find((a) => (job ? a.run.settings.jobId === job.id : a.run.id === adhocRunId)) ?? null);
  const last = $derived(job ? (map.lastResults[job.id] ?? null) : null);
  const stream = $derived(active && !active.queued ? eventsFor?.(active.run.id) : undefined);
  const cs = $derived(stream?.state ?? null);
  const percent = $derived(progressPercent(cs?.progress ?? null));
  const lines = $derived(cs ? recentLines(cs.events, 4) : []);
  const alias = (id: string) => map.instances.find((i) => i.id === id)?.alias ?? "Unknown instance";
  // The clicked step: of the saved job, or the step the ad-hoc run is on.
  const stepCount = $derived(job ? job.steps.length : (active?.run.settings.steps.length ?? 0));
  const idx = $derived(job ? Math.min(Math.max(stepPosition, 1), Math.max(job.steps.length, 1)) - 1 : (active?.step ?? active?.run.steps.find((s) => s.status === "running")?.position ?? 1) - 1);
  const step = $derived(
    job
      ? (() => {
          const st = job.steps[idx];
          return st ? { source: alias(st.sourceId), target: alias(st.targetId), operation: st.operation } : null;
        })()
      : (() => {
          const st = active?.run.settings.steps[idx];
          return st ? { source: st.source.alias, target: st.target.alias, operation: st.operation } : null;
        })(),
  );
  const title = $derived(job?.name ?? active?.run.jobName ?? "Run");
  const tiles = $derived(cs ? liveTiles(cs.counts) : []);
  const startedAt = $derived(active?.run.startedAt ? new Date(active.run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null);
  const scheduleChip = $derived(!job ? "Ad-hoc run" : job.schedule ? `${job.schedule.enabled ? "Scheduled" : "Paused"} · ${job.schedule.cron} ${job.schedule.timezone}` : "Not scheduled");
  const nextRun = $derived(job?.schedule?.enabled ? (job.schedule.nextRuns[0] ?? null) : null);
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

<aside class="card preset-outlined-surface-200-800 bg-surface-50-950 flex h-full flex-col" aria-label="Job details">
  <div class="space-y-2 border-b border-surface-200-800 p-4">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="text-[11px] font-semibold tracking-wide uppercase opacity-60">Selected edge</div>
        <h3 class="h4 break-words">{title}</h3>
      </div>
      <button type="button" class="btn btn-sm preset-tonal-surface" aria-label="Close panel" onclick={onclose}>×</button>
    </div>
    {#if step}
      <p class="text-sm opacity-80">{step.source} → {step.target} · {operationLabel(step.operation)}, step {idx + 1} of {stepCount}</p>
    {/if}
    <div class="flex flex-wrap gap-2">
      {#if active}<span class="badge preset-tonal-primary font-semibold">{active.queued ? "Waiting for lock" : "Running"}</span>{/if}
      <span class="badge preset-tonal-surface">{scheduleChip}</span>
    </div>
  </div>
  <div class="flex-1 space-y-4 p-4">
    {#if active}
      {#if cs}
        {#if cs.progress}
          <div class="space-y-1.5 text-sm">
            <div class="flex justify-between gap-2"><strong>{cs.progress.label ?? "Progress"}</strong><span>{cs.progress.done}{cs.progress.total !== null ? ` / ${cs.progress.total}` : ""}{percent !== null ? ` (${percent}%)` : ""}</span></div>
            <progress class="h-2 w-full" max={cs.progress.total ?? undefined} value={cs.progress.total ? cs.progress.done : undefined} aria-label="Run progress"></progress>
            {#if startedAt}<p class="text-xs opacity-70">Started {startedAt}</p>{/if}
          </div>
        {/if}
        <div class="grid grid-cols-2 gap-2">
          {#each tiles as t (t.label)}
            <div class="rounded-container p-3 {t.tone === 'error' ? 'preset-tonal-error' : 'bg-surface-100-900'}">
              <div class="text-xs {t.tone === 'error' ? '' : 'opacity-70'}">{t.label}</div>
              <div class="text-xl font-bold">{t.value}</div>
            </div>
          {/each}
        </div>
        {#if lines.length}
          <div class="space-y-1.5">
            <div class="text-sm font-semibold">Live log</div>
            <ul class="space-y-0.5 rounded-container bg-surface-950-50 p-3 font-mono text-xs text-surface-50-950" aria-label="Recent log lines">
              {#each lines as line, i (i)}<li class="truncate" title={line}>{line}</li>{/each}
            </ul>
          </div>
        {/if}
      {/if}
      <div class="flex flex-wrap gap-2">
        {#if onopenrun}<button type="button" class="btn flex-1 preset-filled-primary-500" onclick={() => onopenrun(active.run.id)}>Open run</button>{/if}
        {#if confirmCancel}
          <button type="button" class="btn flex-1 preset-filled-error-500" disabled={busy} onclick={() => act(() => api.cancelRun(active.run.id))}>Confirm cancel</button>
          <button type="button" class="btn flex-1 preset-tonal-surface" onclick={() => (confirmCancel = false)}>Keep running</button>
        {:else}
          <button type="button" class="btn flex-1 preset-outlined-error-500" onclick={() => (confirmCancel = true)}>Cancel run</button>
        {/if}
        {#if job && onopenjob}<button type="button" class="btn w-full preset-tonal-surface" onclick={() => onopenjob(job.id)}>Open job</button>{/if}
      </div>
    {:else if job}
      <dl class="space-y-2 text-sm">
        <div class="flex justify-between gap-3"><dt class="opacity-70">Last run</dt><dd class="text-right">{last ? `${statusLabel(last.status)}${last.finishedAt ? ` · ${new Date(last.finishedAt).toLocaleString()}` : ""}` : "Never run"}</dd></div>
        <div class="flex justify-between gap-3"><dt class="opacity-70">Next run</dt><dd class="text-right">{nextRun ? new Date(nextRun).toLocaleString() : job.schedule ? "Paused" : "Not scheduled"}</dd></div>
      </dl>
      <div class="space-y-1.5">
        <div class="text-sm font-semibold">Steps</div>
        <ol class="space-y-1.5 text-sm">
          {#each job.steps as st, i (i)}
            <li class="flex items-center gap-2 rounded-container px-2 py-1.5 {i === idx ? 'bg-surface-100-900 font-semibold' : ''}">
              <span class="opacity-60">{i + 1}</span>
              <span class="badge preset-tonal-surface">{operationLabel(st.operation)}</span>
              <span class="min-w-0 truncate">{alias(st.sourceId)} → {alias(st.targetId)}</span>
            </li>
          {/each}
        </ol>
      </div>
      <div class="flex flex-wrap gap-2">
        {#if onopenjob}<button type="button" class="btn flex-1 preset-filled-primary-500" onclick={() => onopenjob(job.id)}>Open job</button>{/if}
        <button type="button" class="btn flex-1 preset-tonal-primary" disabled={busy} onclick={() => act(() => api.runJob(job.id, true))}>Dry run</button>
      </div>
    {/if}
    {#if error}<p class="text-sm text-error-500" role="alert">{error}</p>{/if}
  </div>
</aside>
