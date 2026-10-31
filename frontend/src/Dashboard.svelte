<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "./lib/session.svelte.ts";
  import { statusLabel } from "./lib/runs.ts";
  import { checkError, inZone, instanceHealth, loadMapInput, refreshInterval, statusTone, type DashboardResponse } from "./lib/dashboard.ts";
  import type { MapInput } from "./lib/flow/map.ts";
  import InstanceMap from "./flow/InstanceMap.svelte";

  /** Optional: opens a run in the History screen. Without it, run names are shown as plain text. */
  let { onopenrun }: { onopenrun?: (runId: string) => void } = $props();

  let data = $state<DashboardResponse | null>(null);
  let map = $state<MapInput | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let visible = $state(typeof document === "undefined" ? true : document.visibilityState === "visible");

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "-");
  const toneCls = { success: "preset-tonal-success", error: "preset-tonal-error", warning: "preset-tonal-warning", neutral: "preset-tonal-surface", primary: "preset-tonal-primary" };
  const healthCls = { ok: "preset-tonal-success", warn: "preset-tonal-warning", error: "preset-tonal-error" };

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
    <section aria-labelledby="d-running" class="space-y-2">
      <h2 id="d-running" class="h5">Running now</h2>
      {#if data.running.length === 0}
        <p class="text-sm opacity-70">Nothing is running.</p>
      {:else}
        <ul class="space-y-1">
          {#each data.running as r (r.id)}
            <li class="card preset-outlined-primary-500 flex flex-wrap items-center gap-3 p-3">
              <span class="badge preset-tonal-primary">running</span>
              {#if onopenrun}<button type="button" class="anchor" onclick={() => onopenrun(r.id)}>{r.jobName}</button>{:else}<span>{r.jobName}</span>{/if}
              <span class="text-xs opacity-70">since {fmt(r.startedAt)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section aria-labelledby="d-stats" class="space-y-2">
      <h2 id="d-stats" class="h5">Last 7 days</h2>
      <dl class="flex gap-6 text-sm">
        <div><dt class="opacity-70">Runs</dt><dd class="text-2xl">{data.stats.runsLast7Days}</dd></div>
        <div><dt class="opacity-70">With failures</dt><dd class="text-2xl {data.stats.failedLast7Days ? 'text-error-600-400' : ''}">{data.stats.failedLast7Days}</dd></div>
      </dl>
    </section>

    <section aria-labelledby="d-map" class="space-y-2">
      <h2 id="d-map" class="h5">Instance map</h2>
      {#if !map || map.instances.length === 0}
        <p class="text-sm opacity-70">Add an instance to see the map.</p>
      {:else}
        <InstanceMap {map} {onopenrun} onchanged={load} />
      {/if}
    </section>

    <section aria-labelledby="d-inst" class="space-y-2">
      <h2 id="d-inst" class="h5">Instances</h2>
      {#if data.instances.length === 0}
        <p class="text-sm opacity-70">No instances yet. Add one on the Instances screen.</p>
      {:else}
        <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {#each data.instances as i (i.id)}
            {@const h = instanceHealth(i)}
            {@const err = checkError(i)}
            <li class="card preset-outlined-surface-200-800 space-y-1 p-4">
              <div class="flex items-center justify-between gap-2">
                <span class="font-semibold">{i.alias}{i.isDefault ? " (default)" : ""}</span>
                <span class="badge {healthCls[h.tone]}">{h.tone === "ok" ? "OK" : h.tone === "warn" ? "Warning" : "Error"}</span>
              </div>
              <p class="text-sm">{h.label}</p>
              <p class="text-xs opacity-70">Immich {i.lastCheck?.version ?? "version unknown"}</p>
              <p class="text-xs opacity-70">Last checked: {i.lastCheckedAt ? fmt(i.lastCheckedAt) : "never"}</p>
              {#if err}<p class="text-xs text-error-600-400">{err}</p>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section aria-labelledby="d-next" class="space-y-2">
      <h2 id="d-next" class="h5">Next scheduled runs</h2>
      {#if data.nextScheduled.length === 0}
        <p class="text-sm opacity-70">No enabled schedules.</p>
      {:else}
        <div class="table-wrap">
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
      <h2 id="d-recent" class="h5">Recent runs</h2>
      {#if data.recentRuns.length === 0}
        <p class="text-sm opacity-70">No runs yet.</p>
      {:else}
        <div class="table-wrap">
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
