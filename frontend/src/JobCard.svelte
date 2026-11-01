<script lang="ts">
  import { formatWhen, OP_LABEL, stepSummary, type JobRecord } from "./lib/jobs.ts";
  import { opBadgeClass, scheduleState } from "./lib/jobCard.ts";
  import { statusClass, statusLabel, type Run } from "./lib/runs.ts";

  let { job, last, alias, busy, onrun, ondry, onedit, onschedule, ondelete }: {
    job: JobRecord;
    /** The job's most recent run; null when it never ran or the lookup failed. */
    last: Run | null;
    alias: (id: string) => string;
    busy: boolean;
    onrun: () => void;
    ondry: () => void;
    onedit: () => void;
    onschedule: () => void;
    ondelete: () => void;
  } = $props();

  const sched = $derived(scheduleState(job.schedule, job.hasMove));
</script>

<section class="card preset-outlined-surface-200-800 bg-surface-50-950 p-4 sm:p-5" aria-label={job.name}>
  <div class="flex flex-wrap justify-between gap-4">
    <div class="min-w-0 space-y-3">
      <h2 class="h5">{job.name}</h2>

      <ol class="flex flex-wrap items-center gap-1.5" aria-label="Steps">
        {#each job.steps as s, i (s.id ?? i)}
          {@const full = stepSummary(s, alias)}
          {#if i > 0}<li class="opacity-60" aria-hidden="true">→</li>{/if}
          <li title={full}>
            <span class="inline-flex items-center gap-2 rounded-container border border-surface-200-800 px-2 py-1 text-xs" aria-hidden="true">
              <span class="badge {opBadgeClass(s.operation)} font-bold">{OP_LABEL[s.operation]}</span>
              <span>{alias(s.sourceId)} → {alias(s.targetId)}</span>
            </span>
            <span class="sr-only">{i + 1}. {full}</span>
          </li>
        {/each}
      </ol>

      <div class="space-y-1 text-sm">
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <strong class="sr-only">Schedule:</strong>
          {#if sched.kind === "none"}
            <span class="opacity-70">No schedule</span>
          {:else}
            <span>{sched.what}</span><span class="opacity-70">· {sched.timezone}</span>
            {#if sched.kind === "paused"}
              <span class="badge preset-tonal-surface">paused</span>
            {:else if sched.next.length}
              <span class="opacity-70">· next</span><span class="badge preset-tonal-primary whitespace-nowrap">{formatWhen(sched.next[0]!, sched.timezone)}</span>
              {#if sched.next.length > 1}<span class="opacity-70">then {sched.next.slice(1).map((r) => formatWhen(r, sched.timezone)).join(" · ")}</span>{/if}
            {/if}
          {/if}
        </p>
        {#if job.hasMove}<p><span class="badge preset-tonal-warning">moves assets</span></p>{/if}
        {#if sched.moveUnconfirmed}
          <p><span class="badge preset-tonal-warning" role="note">Move not confirmed</span> <span class="opacity-80">Open Schedule and confirm the move so scheduled runs may trash assets.</span></p>
        {/if}
      </div>
    </div>

    <div class="flex flex-col gap-3 sm:items-end">
      <p class="flex flex-wrap items-center gap-2 text-xs">
        {#if last}
          <span class="opacity-70">Last run</span><span class="badge {statusClass(last.status)}">{statusLabel(last.status)}</span>
          <span class="opacity-70">{formatWhen(last.finishedAt ?? last.startedAt ?? last.createdAt)}</span>
        {:else}<span class="opacity-70">Never run</span>{/if}
      </p>
      <div class="flex flex-wrap gap-2 sm:justify-end">
        <button type="button" class="btn btn-sm preset-filled-primary-500" disabled={busy} onclick={onrun}>Run now</button>
        <button type="button" class="btn btn-sm preset-tonal-primary" disabled={busy} onclick={ondry}>Dry run</button>
        <button type="button" class="btn btn-sm preset-outlined-surface-200-800" onclick={onedit}>Edit <span class="sr-only">{job.name}</span></button>
        <button type="button" class="btn btn-sm preset-outlined-surface-200-800" onclick={onschedule}>Schedule <span class="sr-only">for {job.name}</span></button>
        <button type="button" class="btn btn-sm preset-tonal-error" disabled={busy} onclick={ondelete}>Delete <span class="sr-only">{job.name}</span></button>
      </div>
    </div>
  </div>
</section>
