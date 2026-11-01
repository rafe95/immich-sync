<script lang="ts">
  import { formatBytes, stepSummaries, type ConsoleState } from "../lib/runs.ts";

  /** Counts and failures for the step picked on the run diagram; the console is filtered to it by the parent. */
  let { progress, selected = $bindable(null) }: { progress: ConsoleState; selected: number | null } = $props();

  const block = $derived(selected === null ? null : (stepSummaries(progress.summaries, progress.failures).find((b) => b.step === selected) ?? null));
  const liveFailures = $derived(selected === null ? [] : progress.failures.filter((f) => f.step === selected));
</script>

{#if selected !== null}
  <div class="card preset-outlined-surface-200-800 space-y-1 p-3 text-sm">
    <div class="flex items-center justify-between gap-2">
      <strong>Step {selected}</strong>
      <button type="button" class="btn btn-sm preset-tonal-surface" onclick={() => (selected = null)}>Show all steps</button>
    </div>
    {#if block?.totals}
      {@const t = block.totals}
      <p>
        Found {t.found} · {t.done} {t.dryRun ? "would be " : ""}{t.doneLabel} · {t.skipped} skipped · {t.failed} failed
        {#if t.inTargetTrash} · {t.inTargetTrash} in target trash (never re-uploaded){/if}
        · {formatBytes(t.bytes)}
      </p>
    {:else}
      <p class="opacity-70">No counts reported for this step yet.</p>
    {/if}
    {#if liveFailures.length}
      <ul class="list-disc pl-5">
        {#each liveFailures as f (f.eventId)}<li>{f.name}{f.message ? `: ${f.message}` : ""}</li>{/each}
      </ul>
    {/if}
  </div>
{:else}
  <p class="text-sm opacity-70">Select a step on the diagram to see its counts and filter the console.</p>
{/if}
