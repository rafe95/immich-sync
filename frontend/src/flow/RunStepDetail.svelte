<script lang="ts">
  import ProgressBar from "../ui/ProgressBar.svelte";
  import { formatBytes, operationLabel, stepSummaries, type ConsoleState, type RunStepSettings } from "../lib/runs.ts";

  /**
   * Counts and failures for one step. The step is the one picked on the diagram (`explicit`; the console is then filtered to it by
   * the parent) or, when nothing is picked, the step that is live now or the last one.
   */
  let {
    progress,
    selected,
    explicit = true,
    liveStep = null,
    steps = [],
    onclear,
  }: { progress: ConsoleState; selected: number | null; explicit?: boolean; liveStep?: number | null; steps?: RunStepSettings[]; onclear?: () => void } = $props();

  const live = $derived(selected !== null && selected === liveStep ? progress.progress : null);
  const livePercent = $derived(live && live.total ? Math.min(100, Math.round((live.done / live.total) * 100)) : null);

  const block = $derived(selected === null ? null : (stepSummaries(progress.summaries, progress.failures).find((b) => b.step === selected) ?? null));
  const liveFailures = $derived(selected === null ? [] : progress.failures.filter((f) => f.step === selected));
  const settings = $derived(selected === null ? null : (steps.find((s) => s.position === selected) ?? null));
</script>

{#if selected !== null}
  <div class="card preset-outlined-surface-200-800 space-y-3 p-3 text-sm">
    <div class="flex items-start justify-between gap-2">
      <div>
        <div class="text-xs font-semibold tracking-wide uppercase opacity-70">{explicit ? "Selected" : liveStep === selected ? "Running" : "Latest"} · Step {selected}</div>
        {#if settings}<h3 class="h6">{operationLabel(settings.operation)} {settings.source.alias} → {settings.target.alias}</h3>{/if}
      </div>
      {#if explicit && onclear}<button type="button" class="btn btn-sm preset-tonal-surface" onclick={onclear}>Show all steps</button>{/if}
    </div>
    {#if live}
      <div class="space-y-1.5">
        <div class="flex justify-between gap-2"><strong>{live.label ?? "Progress"}</strong><span>{live.done}{live.total !== null ? ` / ${live.total}` : ""}</span></div>
        <ProgressBar percent={livePercent} label="Step progress" />
      </div>
    {/if}
    {#if block?.totals}
      {@const t = block.totals}
      <dl class="grid grid-cols-2 gap-2">
        <div class="rounded-container bg-surface-100-900 p-2"><dt class="text-xs opacity-70">Found</dt><dd class="text-lg font-bold">{t.found}</dd></div>
        <div class="rounded-container bg-surface-100-900 p-2"><dt class="text-xs opacity-70">{t.dryRun ? "Would be " : ""}{t.doneLabel}</dt><dd class="text-lg font-bold">{t.done}</dd></div>
        <div class="rounded-container bg-surface-100-900 p-2"><dt class="text-xs opacity-70">Skipped</dt><dd class="text-lg font-bold">{t.skipped}</dd></div>
        <div class="rounded-container bg-surface-100-900 p-2"><dt class="text-xs opacity-70">In target trash</dt><dd class="text-lg font-bold">{t.inTargetTrash}</dd></div>
        <div class="rounded-container p-2 {t.failed ? 'preset-tonal-error' : 'bg-surface-100-900'}"><dt class="text-xs opacity-70">Failed</dt><dd class="text-lg font-bold {t.failed ? 'text-error-600-400' : ''}">{t.failed}</dd></div>
        <div class="rounded-container bg-surface-100-900 p-2"><dt class="text-xs opacity-70">Bytes{t.dryRun ? " to transfer" : ""}</dt><dd class="text-lg font-bold">{formatBytes(t.bytes)}</dd></div>
      </dl>
      {#if t.inTargetTrash}<p class="text-xs opacity-70">Assets in the target's trash are never re-uploaded.</p>{/if}
    {:else}
      <p class="opacity-70">No counts reported for this step yet.</p>
    {/if}
    {#if liveFailures.length}
      <div>
        <h4 class="mb-1 text-xs font-semibold opacity-80">Failed assets</h4>
        <ul class="space-y-1.5" aria-label="Failed assets">
          {#each liveFailures as f (f.eventId)}
            <li class="flex justify-between gap-2 rounded-container border border-error-300-700 px-2 py-1.5">
              <span class="font-semibold break-all">{f.name}</span>
              {#if f.message}<span class="text-right text-error-600-400">{f.message}</span>{/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
{:else}
  <p class="text-sm opacity-70">No steps yet.</p>
{/if}
