<script lang="ts">
  import Toggle from "./ui/Toggle.svelte";
  import { tick } from "svelte";
  import type { RunEvents } from "./lib/runEvents.svelte.ts";
  import { assetOf, eventText, formatBytes, lineVisible, stepSummaries, progressPercent, statusLabel, type EventLevel } from "./lib/runs.ts";

  /** Shared console over one run's event stream (created by the parent). Closing it never affects the run. */
  let { events, stepFilter = null }: { events: RunEvents; stepFilter?: number | null } = $props();

  const cs = $derived(events.state);
  const connection = $derived(events.connection);
  const loadError = $derived(events.loadError);
  let minLevel = $state<EventLevel>("info");
  let showAssets = $state(true);
  let failuresOnly = $state(false);
  let following = $state(true);
  let logEl = $state<HTMLDivElement | null>(null);

  const rank: Record<EventLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };
  const levelCls: Record<EventLevel, string> = { debug: "opacity-60", info: "", warning: "text-warning-600-400", error: "text-error-600-400" };
  const stepOf = (e: { data: unknown }) => (e.data && typeof e.data === "object" && typeof (e.data as { step?: unknown }).step === "number" ? (e.data as { step: number }).step : null);
  const visible = $derived(cs.events.filter((e) => (stepFilter === null || stepOf(e) === stepFilter) && lineVisible(e, { minRank: rank[minLevel], rank: rank[e.level], showAssets, failuresOnly })));
  const blocks = $derived(stepSummaries(cs.summaries, cs.failures));
  const finishedRun = $derived(cs.endStatus !== null || connection === "closed");
  const percent = $derived(progressPercent(cs.progress));
  const outcomeCounts = $derived(Object.entries(cs.counts));
  const time = (iso: string) => new Date(iso).toLocaleTimeString();

  $effect(() => {
    void visible.length;
    if (following && logEl) tick().then(() => logEl && (logEl.scrollTop = logEl.scrollHeight));
  });

  function onScroll() {
    if (!logEl) return;
    following = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  }
  function resume() {
    following = true;
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }

  const connLabel = $derived(
    cs.endStatus ? `Run ${statusLabel(cs.endStatus)}` : { connecting: "Connecting…", live: "Live", reconnecting: "Connection lost, reconnecting…", closed: "Stored log or ended" }[connection],
  );
</script>

<section class="space-y-3" aria-label="Run console">
  <div class="flex flex-wrap items-center gap-3">
    <span class="badge {connection === 'live' ? 'preset-tonal-success' : connection === 'reconnecting' ? 'preset-tonal-warning' : 'preset-tonal-surface'}" role="status" aria-live="polite">{connLabel}</span>
    <label class="flex items-center gap-2 text-sm">
      <span>Level</span>
      <select class="select w-auto" bind:value={minLevel}>
        <option value="debug">debug and up</option>
        <option value="info">info and up</option>
        <option value="warning">warnings and errors</option>
        <option value="error">errors only</option>
      </select>
    </label>
    <Toggle bind:checked={showAssets} disabled={failuresOnly} label="Per-asset lines" />
    <button type="button" class="chip {failuresOnly ? 'preset-filled-error-500' : 'preset-tonal-surface'}" aria-pressed={failuresOnly} onclick={() => (failuresOnly = !failuresOnly)}>
      Only failures{cs.failures.length ? ` (${cs.failures.length}${cs.failuresDropped ? "+" : ""})` : ""}
    </button>
  </div>

  {#if cs.progress}
    <div>
      <div class="mb-1 flex justify-between text-sm">
        <span>{cs.progress.label ?? "Progress"}</span>
        <span>{cs.progress.done}{cs.progress.total !== null ? ` / ${cs.progress.total}` : ""}{percent !== null ? ` (${percent}%)` : ""}</span>
      </div>
      <progress class="h-2 w-full" max={cs.progress.total ?? undefined} value={cs.progress.total ? cs.progress.done : undefined} aria-label="Run progress"></progress>
    </div>
  {/if}

  {#if outcomeCounts.length}
    <ul class="flex flex-wrap gap-2 text-sm" aria-label="Per-asset results so far">
      {#each outcomeCounts as [outcome, n] (outcome)}
        <li class="badge {outcome === 'failed' ? 'preset-tonal-error' : 'preset-tonal-surface'}">{outcome}: {n}</li>
      {/each}
    </ul>
  {/if}

  {#if finishedRun && blocks.length}
    <div class="space-y-3" aria-label="Run summary">
      {#each blocks as b (b.step)}
        <section class="card preset-outlined-surface-200-800 space-y-2 p-4" aria-labelledby="sum-{b.step}">
          <h3 id="sum-{b.step}" class="h6">Step {b.step}: {statusLabel(b.status)}{b.totals?.dryRun ? " (dry run: counts are what would happen)" : ""}</h3>
          {#if b.totals}
            {@const t = b.totals}
            <dl class="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              <div><dt class="opacity-70">Found</dt><dd>{t.found}</dd></div>
              <div><dt class="opacity-70">{t.dryRun ? `Would be ${t.doneLabel === "done" ? "changed" : t.doneLabel}` : t.doneLabel === "done" ? "Changed" : t.doneLabel}</dt><dd>{t.done}</dd></div>
              <div><dt class="opacity-70">Skipped (already present)</dt><dd>{t.skipped}</dd></div>
              <div><dt class="opacity-70">In target trash</dt><dd>{t.inTargetTrash}</dd></div>
              <div><dt class="opacity-70">Failed</dt><dd class={t.failed ? "font-semibold text-error-600-400" : ""}>{t.failed}</dd></div>
              <div><dt class="opacity-70">{t.dryRun ? "To transfer" : "Transferred"}</dt><dd>{formatBytes(t.bytes)}</dd></div>
              {#if t.cancelled}<div><dt class="opacity-70">Cancelled</dt><dd>{t.cancelled}</dd></div>{/if}
            </dl>
            {#if t.inTargetTrash}
              <p class="text-xs opacity-70">Assets in the target's trash are skipped on purpose and never uploaded again. Restore or empty them on the target yourself if you want them handled.</p>
            {/if}
          {:else if b.message}
            <p class="text-sm">{b.message}</p>
          {/if}
          {#if b.failures.length}
            <details>
              <summary class="cursor-pointer text-sm">Failed assets ({b.failures.length})</summary>
              <ul class="mt-2 max-h-64 space-y-1 overflow-auto text-xs">
                {#each b.failures as f (f.eventId)}<li><span class="font-mono">{f.name}</span>{f.message ? `: ${f.message}` : ""}</li>{/each}
              </ul>
            </details>
          {/if}
        </section>
      {/each}
      {#if cs.failuresDropped > 0}<p class="text-xs opacity-70">{cs.failuresDropped} more failures are in the downloaded log.</p>{/if}
    </div>
  {/if}

  {#if loadError}<p class="text-error-500" role="alert">{loadError}</p>{/if}

  <div class="relative">
    <!-- tabindex makes the scrollable log keyboard-scrollable; aria-live is off because a run can log thousands of lines. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      bind:this={logEl}
      onscroll={onScroll}
      class="card preset-outlined-surface-200-800 h-[28rem] overflow-auto p-3 font-mono text-xs"
      role="log"
      aria-label="Run log"
      aria-live="off"
      tabindex="0"
    >
      {#if cs.dropped > 0}
        <p class="mb-2 opacity-70">{cs.dropped} earlier lines are not shown here. Download the log for the full record.</p>
      {/if}
      {#each visible as e (e.id)}
        {@const a = assetOf(e)}
        <div class="flex gap-2 whitespace-pre-wrap break-words {levelCls[e.level]} {e.type === 'summary' ? 'font-semibold' : ''}">
          <span class="shrink-0 opacity-60">{time(e.ts)}</span>
          <span class="w-14 shrink-0 uppercase">{e.level}</span>
          <span>{#if a?.outcome}<span class="badge {a.outcome === 'failed' ? 'preset-tonal-error' : 'preset-tonal-surface'} mr-1">{a.outcome}</span>{/if}{eventText(e)}</span>
        </div>
      {:else}
        <p class="opacity-70">{connection === "connecting" ? "Waiting for events…" : "No log lines at this level."}</p>
      {/each}
    </div>
    {#if !following}
      <button type="button" class="btn btn-sm preset-filled-primary-500 absolute right-4 bottom-4" onclick={resume}>Scroll paused: jump to latest</button>
    {/if}
  </div>
</section>
