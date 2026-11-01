<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "./lib/session.svelte.ts";
  import { statusLabel } from "./lib/runs.ts";
  import { inZone, loadMapInput, refreshInterval, statusTone, summaryCards, type DashboardResponse } from "./lib/dashboard.ts";
  import type { MapInput } from "./lib/flow/map.ts";
  import InstanceMap from "./flow/InstanceMap.svelte";

  /** Optional: opens a run in the History screen. Without it, run names are shown as plain text. */
  let { onopenrun, onopenjob }: { onopenrun?: (runId: string) => void; onopenjob?: (jobId: string) => void } = $props();

  let data = $state<DashboardResponse | null>(null);
  let map = $state<MapInput | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let visible = $state(typeof document === "undefined" ? true : document.visibilityState === "visible");

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "-");
  const toneCls = { success: "preset-tonal-success", error: "preset-tonal-error", warning: "preset-tonal-warning", neutral: "preset-tonal-surface", primary: "preset-tonal-primary" };

  async function load() {
    try {
      const loaded = await loadMapInput(api);
      data = loaded.dashboard;
      map = loaded.map;
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  const hasRunning = $derived((data?.running.length ?? 0) > 0);
  const interval = $derived(refreshInterval(hasRunning, visible));

  onMount(() => {
    const onVis = () => {
      visible = document.visibilityState === "visible";
      if (visible) void load();
    };
    document.addEventListener("visibilitychange", onVis);
    void load();
    return () => document.removeEventListener("visibilitychange", onVis);
  });

  // Re-armed whenever the cadence changes; nothing runs while the tab is hidden.
  $effect(() => {
    if (interval === null) return;
    const t = setInterval(load, interval);
    return () => clearInterval(t);
  });
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h1 class="h3">Dashboard</h1>
    <button type="button" class="btn btn-sm preset-tonal-surface" onclick={load}>Refresh</button>
  </div>

  {#if error}
    <p class="text-error-500" role="alert">Could not load the dashboard: {error}</p>
  {/if}

  {#if loading && !data}
    <p role="status">Loading…</p>
  {:else if data}
    {@const cards = summaryCards(data)}
    <section aria-label="Summary" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div class="card preset-outlined-surface-200-800 bg-surface-50-950 px-4 py-3.5">
        <div class="text-xs font-medium opacity-70">Instances</div>
        <div class="mt-1 text-[22px] font-bold">
          {cards.instances.total}
          {#if cards.instances.attention > 0}
            <span class="text-sm font-medium text-warning-700-300">· {cards.instances.attention} {cards.instances.attention === 1 ? "needs" : "need"} attention</span>
          {/if}
        </div>
      </div>
      <div class="card preset-outlined-surface-200-800 bg-surface-50-950 px-4 py-3.5">
        <div class="text-xs font-medium opacity-70">Running now</div>
        <div class="mt-1 text-[22px] font-bold">
          {cards.running.count}
          {#if cards.running.first}
            {@const first = cards.running.first}
            <span class="text-sm font-medium">·
              {#if onopenrun}<button type="button" class="anchor" onclick={() => onopenrun(first.id)}>{first.jobName}</button>{:else}{first.jobName}{/if}{#if cards.running.count > 1}
                <span class="opacity-70">+{cards.running.count - 1} more</span>{/if}
            </span>
          {:else}
            <span class="text-sm font-medium opacity-70">· nothing running</span>
          {/if}
        </div>
      </div>
      <div class="card preset-outlined-surface-200-800 bg-surface-50-950 px-4 py-3.5">
        <div class="text-xs font-medium opacity-70">Next scheduled</div>
        {#if cards.next}
          <div class="mt-1 text-[22px] font-bold">{new Date(cards.next.nextRun).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
          <div class="truncate text-sm opacity-80" title={cards.next.jobName}>{new Date(cards.next.nextRun).toLocaleDateString()} · {cards.next.jobName}</div>
        {:else}
          <div class="mt-1 text-[22px] font-bold opacity-70">None</div>
          <div class="text-sm opacity-80">No enabled schedules</div>
        {/if}
      </div>
      <div class="card preset-outlined-surface-200-800 bg-surface-50-950 px-4 py-3.5">
        <div class="text-xs font-medium opacity-70">Last 7 days</div>
        <div class="mt-1 text-[22px] font-bold">
          {cards.week.runs} {cards.week.runs === 1 ? "run" : "runs"}
          {#if cards.week.failed > 0}<span class="text-sm font-medium text-error-600-400">· {cards.week.failed} with failures</span>{/if}
        </div>
      </div>
    </section>

    <section aria-label="Instance map and details">
      {#if map}
        <InstanceMap {map} {onopenrun} {onopenjob} onchanged={load} />
      {/if}
    </section>

    <section aria-labelledby="d-next" class="space-y-2">
      <h2 id="d-next" class="text-base font-semibold">Next scheduled runs</h2>
      {#if data.nextScheduled.length === 0}
        <p class="text-sm opacity-70">No enabled schedules.</p>
      {:else}
        <div class="table-wrap overflow-hidden rounded-container border border-surface-200-800 bg-surface-50-950">
          <table class="table">
            <caption class="sr-only">Upcoming scheduled runs</caption>
            <thead><tr><th>Job</th><th>Next run (schedule time zone)</th><th>Next run (your time)</th></tr></thead>
            <tbody>
              {#each data.nextScheduled as s (s.jobId)}
                <tr>
                  <td>{s.jobName}<div class="text-xs opacity-70">{s.cron}</div></td>
                  <td>{s.nextRun ? inZone(s.nextRun, s.timezone) : "-"} <span class="text-xs opacity-70">{s.timezone}</span></td>
                  <td>{fmt(s.nextRun)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section aria-labelledby="d-recent" class="space-y-2">
      <h2 id="d-recent" class="text-base font-semibold">Recent runs</h2>
      {#if data.recentRuns.length === 0}
        <p class="text-sm opacity-70">No runs yet.</p>
      {:else}
        <div class="table-wrap overflow-hidden rounded-container border border-surface-200-800 bg-surface-50-950">
          <table class="table">
            <caption class="sr-only">The last runs, newest first</caption>
            <thead><tr><th>Started</th><th>Run</th><th>Status</th><th>Finished</th></tr></thead>
            <tbody>
              {#each data.recentRuns as r (r.id)}
                <tr>
                  <td>{fmt(r.startedAt ?? r.createdAt)}</td>
                  <td>
                    {#if onopenrun}<button type="button" class="anchor" onclick={() => onopenrun(r.id)} aria-label={`Open run ${r.jobName} started ${fmt(r.startedAt ?? r.createdAt)}`}>{r.jobName}</button>{:else}{r.jobName}{/if}{r.dryRun ? " (dry run)" : ""}
                    <div class="text-xs opacity-70">{r.trigger}</div>
                  </td>
                  <td>
                    <span class="badge {toneCls[statusTone(r.status)]}">{statusLabel(r.status)}</span>
                    {#if r.status === "skipped"}<div class="text-xs opacity-70">Previous run was still going</div>{/if}
                  </td>
                  <td>{fmt(r.finishedAt)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <p class="text-xs opacity-70" role="status">{interval === null ? "Updates paused while this tab is hidden." : `Updates every ${interval / 1000} seconds.`}</p>
  {/if}
</div>
