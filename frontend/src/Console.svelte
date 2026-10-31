<script lang="ts">
  import { tick } from "svelte";
  import { api } from "./lib/session.svelte.ts";
  import {
    assetOf, eventText, formatBytes, lineVisible, stepSummaries, eventsUrl, initialConsole, progressPercent, reconnectDelay, reduceEvents, statusLabel,
    type ConsoleState, type EventLevel, type RunEvent, type RunStatus,
  } from "./lib/runs.ts";

  /**
   * Shared console: "live" streams /api/runs/:id/events (SSE, resumes after the last event id);
   * "replay" reads the stored log. Closing this component never affects the run.
   */
  let { runId, mode, onend }: { runId: string; mode: "live" | "replay"; onend?: (status: RunStatus) => void } = $props();

  let cs = $state<ConsoleState>(initialConsole());
  let connection = $state<"connecting" | "live" | "reconnecting" | "closed">("connecting");
  let loadError = $state<string | null>(null);
  let minLevel = $state<EventLevel>("info");
  let showAssets = $state(true);
  let failuresOnly = $state(false);
  let following = $state(true);
  let logEl = $state<HTMLDivElement | null>(null);

  const rank: Record<EventLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };
  const levelCls: Record<EventLevel, string> = { debug: "opacity-60", info: "", warning: "text-warning-600-400", error: "text-error-600-400" };
  const visible = $derived(cs.events.filter((e) => lineVisible(e, { minRank: rank[minLevel], rank: rank[e.level], showAssets, failuresOnly })));
  const blocks = $derived(stepSummaries(cs.summaries, cs.failures));
  const finishedRun = $derived(cs.endStatus !== null || (mode === "replay" && connection === "closed"));
  const percent = $derived(progressPercent(cs.progress));
  const outcomeCounts = $derived(Object.entries(cs.counts));
  const time = (iso: string) => new Date(iso).toLocaleTimeString();

  // Events are buffered and applied in one batch so a fast log doesn't re-render per line.
  let buffer: RunEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  function push(events: RunEvent[]) {
    buffer.push(...events);
    flushTimer ??= setTimeout(flush, 100);
  }
  function flush() {
    flushTimer = null;
    if (!buffer.length) return;
    cs = reduceEvents(cs, buffer);
    buffer = [];
  }

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

  $effect(() => {
    const id = runId;
    cs = initialConsole();
    buffer = [];
    loadError = null;
    connection = "connecting";
    following = true;
    let stopped = false;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    // Cursor owned by this connection loop; the reducer also ignores anything at or below it.
    let cursor = 0;

    const finish = (status: RunStatus) => {
      flush();
      connection = "closed";
      cs = { ...cs, endStatus: status };
      onend?.(status);
    };

    async function replay() {
      try {
        let after = 0;
        for (;;) {
          const page = await api.getRunLog(id, after);
          if (stopped) return;
          push(page.events);
          if (page.events.length < 1000 || page.nextAfter === null) break;
          after = page.nextAfter;
        }
        flush();
        connection = "closed";
      } catch (e) {
        loadError = e instanceof Error ? e.message : String(e);
        connection = "closed";
      }
    }

    function connect() {
      if (stopped) return;
      es = new EventSource(eventsUrl(id, cursor), { withCredentials: true });
      es.onopen = () => {
        connection = "live";
        attempt = 0;
      };
      es.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data) as RunEvent;
          cursor = Math.max(cursor, e.id);
          push([e]);
        } catch {
          /* ignore malformed frame */
        }
      };
      es.addEventListener("end", (m) => {
        let status: RunStatus = "completed";
        try {
          status = (JSON.parse((m as MessageEvent).data) as { status: RunStatus }).status;
        } catch {
          /* keep default; the run record is authoritative */
        }
        es?.close();
        stopped = true;
        finish(status);
      });
      es.onerror = () => {
        // The browser would retry on its own, but a closed source or a lost session needs handling here.
        es?.close();
        if (stopped) return;
        connection = "reconnecting";
        // A 401 is detected by asking the API; the client then flips the app to the login screen.
        api.getRun(id).catch((e) => {
          if (e && (e as { status?: number }).status === 404) {
            loadError = "This run no longer exists.";
            stopped = true;
            connection = "closed";
          }
        });
        retry = setTimeout(connect, reconnectDelay(attempt++));
      };
    }

    if (mode === "replay") void replay();
    else connect();

    return () => {
      stopped = true;
      es?.close();
      if (retry) clearTimeout(retry);
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
    };
  });

  const connLabel = $derived(
    cs.endStatus ? `Run ${statusLabel(cs.endStatus)}` : { connecting: "Connecting…", live: "Live", reconnecting: "Connection lost, reconnecting…", closed: mode === "replay" ? "Stored log" : "Disconnected" }[connection],
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
    <label class="flex items-center gap-2 text-sm"><input class="checkbox" type="checkbox" bind:checked={showAssets} disabled={failuresOnly} /> Per-asset lines</label>
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
