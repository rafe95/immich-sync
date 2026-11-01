<script lang="ts">
  import { onMount } from "svelte";
  import RunView from "./RunView.svelte";
  import { api } from "./lib/session.svelte.ts";
  import RunsTable from "./RunsTable.svelte";
  import { RUN_STATUSES, statusLabel, type Run, type RunStatus } from "./lib/runs.ts";

  let { onrunreal, openId = $bindable(null) }: { onrunreal: (run: Run) => void; openId: string | null } = $props();

  const PAGE = 20;
  let runs = $state<Run[]>([]);
  let total = $state(0);
  let offset = $state(0);
  let status = $state<RunStatus | "">("");
  let loading = $state(true);
  let error = $state<string | null>(null);

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
</script>

<div class="space-y-4">
  {#if openId}
    <div class="flex items-center gap-3">
      <button type="button" class="btn preset-tonal-surface" onclick={() => { openId = null; void load(); }}>← Back to history</button>
      <h1 class="h3">Run</h1>
    </div>
    <RunView runId={openId} {onrunreal} />
  {:else}
    <div>
      <h1 class="h3">History</h1>
      <p class="text-sm opacity-70">Every run, kept after restarts. Open one to replay its log.</p>
    </div>

    <section class="card preset-outlined-surface-200-800 overflow-hidden" aria-label="Runs">
      <div class="border-surface-200-800 flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <label class="flex items-center gap-2 text-sm">
          <span class="font-semibold">Status</span>
          <select class="select w-auto" bind:value={status} onchange={changeFilter}>
            <option value="">All</option>
            {#each RUN_STATUSES as s (s)}<option value={s}>{statusLabel(s)}</option>{/each}
          </select>
        </label>
        {#if !error && !loading && runs.length > 0}
          <span class="text-sm opacity-70">Showing {offset + 1} to {last} of {total}</span>
        {/if}
      </div>

      {#if error}
        <div class="space-y-2 p-4">
          <p class="text-error-500" role="alert">Could not load runs: {error}</p>
          <button type="button" class="btn preset-tonal-surface" onclick={load}>Retry</button>
        </div>
      {:else if loading}
        <p class="p-4" role="status">Loading runs…</p>
      {:else if runs.length === 0}
        <p class="p-4 opacity-70">{status ? "No runs with this status." : "No runs yet."}</p>
      {:else}
        <RunsTable {runs} onopen={(id) => (openId = id)} />
        <nav class="border-surface-200-800 flex flex-wrap items-center gap-3 border-t p-3" aria-label="History pages">
          <button type="button" class="btn btn-sm preset-tonal-surface" disabled={offset === 0} onclick={() => go(-PAGE)}>Previous</button>
          <span class="text-sm" aria-live="polite">{offset + 1} to {last} of {total}</span>
          <button type="button" class="btn btn-sm preset-tonal-surface" disabled={offset + PAGE >= total} onclick={() => go(PAGE)}>Next</button>
        </nav>
      {/if}
    </section>
  {/if}
</div>
