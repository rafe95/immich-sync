<script lang="ts">
  import { onMount } from "svelte";
  import RunView from "./RunView.svelte";
  import { ApiError, type Instance } from "./lib/api.ts";
  import { api } from "./lib/session.svelte.ts";
  import { buildRunBody, defaultForm, formFromRun, operationLabel, type Run, type RunForm } from "./lib/runs.ts";

  let { activeRunId = $bindable(null), prefill = null }: { activeRunId: string | null; prefill: RunForm | null } = $props();

  let instances = $state<Instance[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  // The screen is mounted fresh for each prefill (History's "Run for real"), so the initial value is what we want.
  // svelte-ignore state_referenced_locally
  let form = $state<RunForm>(prefill ? { ...prefill } : defaultForm());
  let errors = $state<string[]>([]);
  let submitting = $state(false);
  let confirmDialog = $state<HTMLDialogElement | null>(null);
  let pendingDryRun = $state(false);

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const byId = $derived(new Map(instances.map((i) => [i.id, i])));
  const source = $derived(byId.get(form.sourceId));
  const target = $derived(byId.get(form.targetId));
  const sameInstance = $derived(!!form.sourceId && form.sourceId === form.targetId);
  const isMove = $derived(form.operation === "move");

  function health(i: Instance | undefined) {
    if (!i) return null;
    if (!i.lastCheck) return "not checked yet";
    return i.lastCheck.ok ? null : "last connection check failed";
  }
  const optionLabel = (i: Instance) => `${i.alias}${i.isDefault ? " (default)" : ""}${i.lastCheck === null ? " · not checked" : i.lastCheck.ok ? " · OK" : " · check failed"}`;

  async function load() {
    loading = true;
    try {
      instances = await api.listInstances();
      loadError = null;
      if (!form.sourceId && !form.targetId) {
        const d = instances.find((i) => i.isDefault);
        if (d) form.sourceId = d.id;
      }
    } catch (e) {
      loadError = msg(e);
    } finally {
      loading = false;
    }
  }
  onMount(load);

  /** Entry point for both the submit button and "Run for real". A real move asks first. */
  function submit(dryRun: boolean) {
    errors = [];
    const built = buildRunBody(form, { source: source?.alias, target: target?.alias }, dryRun);
    if (!built.ok) {
      errors = built.problems;
      return;
    }
    if (form.operation === "move" && !dryRun) {
      pendingDryRun = dryRun;
      confirmDialog?.showModal();
      return;
    }
    void send(dryRun);
  }

  async function send(dryRun: boolean) {
    confirmDialog?.close();
    const built = buildRunBody(form, { source: source?.alias, target: target?.alias }, dryRun);
    if (!built.ok) return;
    submitting = true;
    errors = [];
    try {
      const run = await api.startRun(built.body);
      activeRunId = run.id;
    } catch (e) {
      errors = e instanceof ApiError && e.problems.length ? e.problems : [msg(e)];
    } finally {
      submitting = false;
    }
  }

  function runReal(run: Run) {
    const f = formFromRun(run);
    if (!f) return;
    form = f;
    submit(false);
  }

  const summary = $derived(
    `${operationLabel(form.operation)} ${form.kind === "all" ? "photos and videos" : form.kind} from ${source?.alias ?? "…"} to ${target?.alias ?? "…"}, ` +
      (form.rangeMode === "all" ? "all dates" : `taken ${form.from ? `from ${form.from} ` : "up to "}${form.from ? "to " : ""}${form.to || "…"}`) +
      (form.operation === "sync_metadata" ? ", metadata only" : form.metadata ? ", with metadata" : ", without metadata") +
      (form.dryRun ? ". Dry run: nothing will change." : "."),
  );
</script>

<div class="space-y-4">
  <h1 class="h3">Run</h1>

  {#if loading}
    <p role="status">Loading instances…</p>
  {:else if loadError}
    <p class="text-error-500" role="alert">Could not load instances: {loadError}</p>
    <button type="button" class="btn preset-tonal-surface" onclick={load}>Retry</button>
  {:else if instances.length < 2}
    <p class="opacity-70">A run needs two different instances. Register them on the Instances screen first.</p>
  {:else}
    <form class="card preset-outlined-surface-200-800 max-w-3xl space-y-4 p-4" onsubmit={(e) => { e.preventDefault(); submit(form.dryRun); }} aria-labelledby="run-form-title">
      <h2 id="run-form-title" class="h5">One-off operation</h2>

      <fieldset class="space-y-1">
        <legend class="label-text">Operation</legend>
        <div class="flex flex-wrap gap-4">
          {#each [["copy", "Copy"], ["move", "Move"], ["sync_metadata", "Sync metadata"]] as const as [value, label] (value)}
            <label class="flex items-center gap-2"><input class="radio" type="radio" name="operation" {value} bind:group={form.operation} /> {label}</label>
          {/each}
        </div>
        {#if isMove}
          <p class="text-sm opacity-80">Move copies each asset, verifies it on the target, and only then sends the source asset to the source's trash. Nothing is permanently deleted.</p>
        {/if}
      </fieldset>

      <div class="grid gap-4 sm:grid-cols-2">
        <label class="label">
          <span class="label-text">Source</span>
          <select class="select" bind:value={form.sourceId} required aria-describedby="src-health">
            <option value="" disabled>Choose…</option>
            {#each instances as i (i.id)}<option value={i.id}>{optionLabel(i)}</option>{/each}
          </select>
          <span id="src-health" class="text-xs {health(source) ? 'text-warning-600-400' : 'opacity-70'}">{health(source) ? `Warning: ${health(source)}.` : "Assets are read from here."}</span>
        </label>
        <label class="label">
          <span class="label-text">Target</span>
          <select class="select" bind:value={form.targetId} required aria-describedby="tgt-health">
            <option value="" disabled>Choose…</option>
            {#each instances as i (i.id)}<option value={i.id}>{optionLabel(i)}</option>{/each}
          </select>
          <span id="tgt-health" class="text-xs {health(target) ? 'text-warning-600-400' : 'opacity-70'}">{health(target) ? `Warning: ${health(target)}.` : "Assets are written here."}</span>
        </label>
      </div>
      {#if sameInstance}<p class="text-sm text-error-500" role="alert">Source and target must be different instances.</p>{/if}

      <fieldset class="space-y-2">
        <legend class="label-text">Date taken</legend>
        <div class="flex flex-wrap gap-4">
          <label class="flex items-center gap-2"><input class="radio" type="radio" name="range" value="all" bind:group={form.rangeMode} /> All assets</label>
          <label class="flex items-center gap-2"><input class="radio" type="radio" name="range" value="window" bind:group={form.rangeMode} /> Date window</label>
        </div>
        {#if form.rangeMode === "window"}
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="label"><span class="label-text">From (optional)</span><input class="input" type="date" bind:value={form.from} /></label>
            <label class="label"><span class="label-text">To (required)</span><input class="input" type="date" bind:value={form.to} required /></label>
          </div>
        {/if}
      </fieldset>

      <label class="label max-w-xs">
        <span class="label-text">Kind</span>
        <select class="select" bind:value={form.kind}>
          <option value="all">Photos and videos</option>
          <option value="photos">Photos only</option>
          <option value="videos">Videos only</option>
        </select>
      </label>

      <label class="flex items-center gap-2">
        <input class="checkbox" type="checkbox" bind:checked={form.metadata} disabled={form.operation === "sync_metadata"} />
        <span>Sync metadata{form.operation === "sync_metadata" ? " (always on for this operation)" : ""}</span>
      </label>

      <label class="flex items-start gap-2 rounded-container p-3 {form.dryRun ? 'preset-tonal-success' : 'preset-tonal-warning'}">
        <input class="checkbox mt-1" type="checkbox" bind:checked={form.dryRun} />
        <span>
          <strong>Dry run</strong>: inspect and report only. {form.dryRun ? "No changes are made on either server." : "Off: this run will change the target" + (isMove ? " and trash source assets after verification." : ".")}
        </span>
      </label>

      <p class="text-sm" aria-live="polite"><strong>Summary:</strong> {summary}</p>

      {#if errors.length}
        <ul class="list-disc pl-5 text-sm text-error-500" role="alert">
          {#each errors as p (p)}<li>{p}</li>{/each}
        </ul>
      {/if}

      <button class="btn preset-filled-primary-500" type="submit" disabled={submitting || sameInstance}>
        {submitting ? "Starting…" : form.dryRun ? "Start dry run" : isMove ? "Review and start move…" : "Start run"}
      </button>
    </form>
  {/if}

  <dialog bind:this={confirmDialog} class="card preset-filled-surface-100-900 m-auto max-w-lg space-y-3 p-5 backdrop:bg-black/50" aria-labelledby="confirm-title">
    <h2 id="confirm-title" class="h5">Move assets from {source?.alias ?? "the source"}?</h2>
    <p>
      Each asset is copied to <strong>{target?.alias}</strong> and checked there first. Only after it is verified (and its metadata synced, if enabled) is it sent to the
      <strong>trash</strong> of <strong>{source?.alias}</strong>. Nothing is permanently deleted, and you can restore trashed assets from that server.
    </p>
    <div class="flex flex-wrap justify-end gap-2">
      <button type="button" class="btn preset-tonal-surface" onclick={() => confirmDialog?.close()}>Cancel</button>
      <button type="button" class="btn preset-filled-error-500" onclick={() => send(pendingDryRun)}>Move and trash on {source?.alias}</button>
    </div>
  </dialog>

  {#if activeRunId}
    <hr class="border-surface-200-800" />
    <RunView runId={activeRunId} onrunreal={runReal} />
  {/if}
</div>
