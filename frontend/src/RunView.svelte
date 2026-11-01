<script lang="ts">
  import { onMount } from "svelte";
  import Console from "./Console.svelte";
  import RunDiagram from "./flow/RunDiagram.svelte";
  import { createRunEvents, type RunEvents } from "./lib/runEvents.svelte.ts";
  import { api } from "./lib/session.svelte.ts";
  import { formFromRun, isTerminal, logAsJson, logAsText, operationLabel, statusClass, statusLabel, type Run, type RunStatus } from "./lib/runs.ts";

  /** A run's header, console, cancel, log download and "Run for real". Shared by the Run and History screens. */
  let { runId, onrunreal }: { runId: string; onrunreal?: (run: Run) => void } = $props();

  let run = $state<Run | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let cancelling = $state(false);
  let downloading = $state(false);
  // Chosen once per run, when it first loads: a finished run is replayed from the stored log, an active one is streamed.
  let mode = $state<"live" | "replay" | null>(null);

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "-");
  const finished = $derived(run ? isTerminal(run.status) : false);
  const canRunReal = $derived(!!run && finished && run.dryRun && run.status !== "failed" && formFromRun(run) !== null);

  async function load() {
    try {
      run = await api.getRun(runId);
      mode ??= isTerminal(run.status) ? "replay" : "live";
      error = null;
    } catch (e) {
      error = msg(e);
    }
  }
  // Reload when a different run is shown.
  let loadedFor = "";
  $effect(() => {
    if (runId !== loadedFor) {
      loadedFor = runId;
      run = null;
      mode = null;
      notice = null;
      cancelling = false;
      stepFilter = null;
      void load();
    }
  });
  onMount(() => {
    // Status changes (queued to running) are not SSE events, so refresh the header while active.
    const t = setInterval(() => {
      if (run && !isTerminal(run.status)) void load();
    }, 3000);
    return () => clearInterval(t);
  });

  async function cancel() {
    cancelling = true;
    try {
      await api.cancelRun(runId);
      notice = "Cancel requested. The run stops after the current asset; verified work is kept.";
    } catch (e) {
      notice = msg(e);
      cancelling = false;
    }
  }

  async function download(kind: "text" | "json") {
    downloading = true;
    try {
      const events = await api.getFullRunLog(runId);
      const body = kind === "json" ? logAsJson(events) : logAsText(events);
      const url = URL.createObjectURL(new Blob([body], { type: kind === "json" ? "application/json" : "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `run-${runId}.${kind === "json" ? "json" : "log"}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      notice = `Could not download the log: ${msg(e)}`;
    } finally {
      downloading = false;
    }
  }

  async function ended() {
    cancelling = false;
    await load();
  }

  // One event stream per run, handed to the console (and later the diagram).
  let events = $state<RunEvents | null>(null);
  let stepFilter = $state<number | null>(null);
  $effect(() => {
    if (!mode) return;
    const e = createRunEvents(api, runId, mode, () => void ended());
    events = e;
    e.start();
    return () => e.stop();
  });

  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const summaryEntries = (v: unknown): [string, unknown][] => (isObj(v) ? Object.entries(v).filter(([, x]) => typeof x === "number" || typeof x === "string") : []);
</script>

<div class="space-y-4">
  {#if error && !run}
    <p class="text-error-500" role="alert">Could not load the run: {error}</p>
    <button type="button" class="btn preset-tonal-surface" onclick={load}>Retry</button>
  {:else if !run}
    <p role="status">Loading run…</p>
  {:else}
    <div class="card preset-outlined-surface-200-800 space-y-2 p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="h5">{run.jobName}</h2>
        <span class="badge {statusClass(run.status)}" role="status" aria-live="polite">{statusLabel(run.status)}{run.dryRun ? " · dry run" : ""}</span>
      </div>
      {#each run.settings.steps as s (s.position)}
        <p class="text-sm">
          Step {s.position}: {operationLabel(s.operation)} from <strong>{s.source.alias}</strong> to <strong>{s.target.alias}</strong>
          · {s.options.range ? ("lastDays" in s.options.range ? `last ${s.options.range.lastDays} days` : `${"from" in s.options.range && s.options.range.from ? s.options.range.from : "beginning"} to ${"to" in s.options.range && s.options.range.to ? s.options.range.to : "now"}`) : "all dates"}
          · {s.options.kind}{s.operation === "sync_metadata" ? "" : s.options.metadata ? " · with metadata" : " · without metadata"}{s.options.includeTrashed ? " · including source trash" : ""}
          {#if s.options.dryRun}· <em>dry run: no changes on either server</em>{/if}
        </p>
      {/each}
      <p class="text-xs opacity-70">
        Created {fmt(run.createdAt)} · started {fmt(run.startedAt)} · finished {fmt(run.finishedAt)} · {run.trigger}
      </p>
      <div class="flex flex-wrap gap-2">
        {#if !finished}
          <button type="button" class="btn preset-filled-error-500" onclick={cancel} disabled={cancelling}>{cancelling ? "Cancelling…" : "Cancel run"}</button>
        {/if}
        {#if canRunReal && onrunreal}
          <button type="button" class="btn preset-filled-primary-500" onclick={() => run && onrunreal(run)}>Run for real with these settings</button>
        {/if}
        <button type="button" class="btn preset-tonal-surface" onclick={() => download("text")} disabled={downloading}>Download log (text)</button>
        <button type="button" class="btn preset-tonal-surface" onclick={() => download("json")} disabled={downloading}>Download log (JSON)</button>
      </div>
      {#if notice}<p class="text-sm" role="status">{notice}</p>{/if}
    </div>
  {/if}

  {#if run && events && run.settings.steps.length}
    <RunDiagram {run} progress={events.state} bind:selected={stepFilter} />
  {/if}

  {#if events}
    <Console {events} {stepFilter} />
  {/if}

  {#if run && finished}
    <div class="card preset-outlined-surface-200-800 space-y-2 p-4">
      <h3 class="h6">Summary</h3>
      {#each run.steps as st (st.position)}
        <div>
          <p class="text-sm font-semibold">Step {st.position}: {statusLabel(st.status)}</p>
          {#if summaryEntries(st.summary).length}
            <dl class="grid grid-cols-2 gap-x-4 text-sm sm:grid-cols-4">
              {#each summaryEntries(st.summary) as [k, v] (k)}
                <div class="flex justify-between gap-2"><dt class="opacity-70">{k}</dt><dd>{v}</dd></div>
              {/each}
            </dl>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
