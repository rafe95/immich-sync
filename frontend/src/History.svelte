<script lang="ts">
  import { onMount } from "svelte";
  import RunView from "./RunView.svelte";
  import { api } from "./lib/session.svelte.ts";
  import { RUN_STATUSES, statusClass, statusLabel, type Run, type RunStatus } from "./lib/runs.ts";

  let { onrunreal, openId = $bindable(null) }: { onrunreal: (run: Run) => void; openId: string | null } = $props();

  const PAGE = 20;
  let runs = $state<Run[]>([]);
  let total = $state(0);
  let offset = $state(0);
  let status = $state<RunStatus | "">("");
  let loading = $state(true);
  let error = $state<string | null>(null);

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "-");
  const last = $derived(Math.min(offset + PAGE, total));

  async function load() {
    loading = true;
    try {
      const page = await api.listRuns({ limit: PAGE, offset, status });
      runs = page.runs;
      total = page.total;
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }
  onMount(load);

  function changeFilter() {
    offset = 0;
    void load();
  }
  function go(delta: number) {
    offset = Math.max(0, offset + delta);
    void load();
  }
  const stepText = (r: Run) => r.settings.steps.map((s) => `${s.operation.replace("_", " ")} ${s.source.alias} to ${s.target.alias}`).join("; ");
</script>

<div class="space-y-4">
  {#if openId}
    <div class="flex items-center gap-3">
      <button type="button" class="btn preset-tonal-surface" onclick={() => { openId = null; void load(); }}>← Back to history</button>
      <h1 class="h3">Run</h1>
    </div>
    <RunView runId={openId} {onrunreal} />
  {:else}
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h1 class="h3">History</h1>
      <label class="flex items-center gap-2 text-sm">
        <span>Status</span>
        <select class="select w-auto" bind:value={status} onchange={changeFilter}>
          <option value="">All</option>
          {#each RUN_STATUSES as s (s)}<option value={s}>{statusLabel(s)}</option>{/each}
        </select>
      </label>
    </div>

    {#if error}
      <p class="text-error-500" role="alert">Could not load runs: {error}</p>
      <button type="button" class="btn preset-tonal-surface" onclick={load}>Retry</button>
    {:else if loading}
      <p role="status">Loading runs…</p>
    {:else if runs.length === 0}
      <p class="opacity-70">{status ? "No runs with this status." : "No runs yet."}</p>
    {:else}
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Past and current runs, newest first</caption>
          <thead><tr><th>Started</th><th>Run</th><th>Status</th><th>Finished</th><th><span class="sr-only">Open</span></th></tr></thead>
          <tbody>
            {#each runs as r (r.id)}
              <tr>
                <td>{fmt(r.startedAt ?? r.createdAt)}</td>
                <td>
                  <div>{r.jobName}{r.dryRun ? " (dry run)" : ""}</div>
                  <div class="text-xs opacity-70">{stepText(r)} · {r.trigger}</div>
                </td>
                <td><span class="badge {statusClass(r.status)}">{statusLabel(r.status)}</span></td>
                <td>{fmt(r.finishedAt)}</td>
                <td><button type="button" class="btn btn-sm preset-tonal-surface" onclick={() => (openId = r.id)} aria-label={`Open run ${r.jobName} started ${fmt(r.startedAt ?? r.createdAt)}`}>Open</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <nav class="flex flex-wrap items-center gap-3" aria-label="History pages">
        <button type="button" class="btn btn-sm preset-tonal-surface" disabled={offset === 0} onclick={() => go(-PAGE)}>Previous</button>
        <span class="text-sm" aria-live="polite">{offset + 1} to {last} of {total}</span>
        <button type="button" class="btn btn-sm preset-tonal-surface" disabled={offset + PAGE >= total} onclick={() => go(PAGE)}>Next</button>
      </nav>
    {/if}
  {/if}
</div>
