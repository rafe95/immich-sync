<script lang="ts">
  import Toggle from "./ui/Toggle.svelte";
  import { onMount } from "svelte";
  import OperationPicker from "./OperationPicker.svelte";
  import Segmented from "./ui/Segmented.svelte";
  import RunSidePanels from "./RunSidePanels.svelte";
  import RunView from "./RunView.svelte";
  import ConfirmDialog from "./ui/ConfirmDialog.svelte";
  import { ApiError, type Instance } from "./lib/api.ts";
  import { api } from "./lib/session.svelte.ts";
  import { buildRunBody, defaultForm, formFromRun, operationLabel, type Run, type RunForm } from "./lib/runs.ts";

  const RANGE_OPTIONS = [{ value: "all", label: "All assets" }, { value: "window", label: "Date window" }] as const;

  let { activeRunId = $bindable(null), prefill = null }: { activeRunId: string | null; prefill: RunForm | null } = $props();

  let instances = $state<Instance[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  // The screen is mounted fresh for each prefill (History's "Run for real"), so the initial value is what we want.
  // svelte-ignore state_referenced_locally
  let form = $state<RunForm>(prefill ? { ...prefill } : defaultForm());
  let errors = $state<string[]>([]);
  let submitting = $state(false);
  let confirmOpen = $state(false);
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
      confirmOpen = true;
      return;
    }
    void send(dryRun);
  }

  async function send(dryRun: boolean) {
    confirmOpen = false;
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
      (form.rangeMode === "all" ? "all dates" : `taken ${form.from ? `from ${form.from}` : ""}${form.from && form.to ? " " : ""}${form.to ? `${form.from ? "to" : "up to"} ${form.to}` : form.from ? "onwards" : ""}`) +
      (form.operation === "sync_metadata" ? ", metadata only" : form.metadata ? ", with metadata" : ", without metadata") +
      (form.operation !== "move" && form.includeTrashed ? ", including the source's trash" : "") +
      (form.dryRun ? ". Dry run: nothing will change." : "."),
  );
</script>

<div class="space-y-4">
  <div>
    <h1 class="h3">Run</h1>
    <p class="text-sm opacity-70">Copy, move or sync metadata between two instances, once.</p>
  </div>

  {#if loading}
    <p role="status">Loading instances…</p>
  {:else if loadError}
    <p class="text-error-500" role="alert">Could not load instances: {loadError}</p>
    <button type="button" class="btn preset-tonal-surface" onclick={load}>Retry</button>
  {:else if instances.length < 2}
    <p class="opacity-70">A run needs two different instances. Register them on the Dashboard first.</p>
  {:else}
    <div class="flex flex-wrap items-start gap-4">
      <form class="card preset-outlined-surface-200-800 min-w-0 flex-1 basis-[34rem] space-y-4 p-5" onsubmit={(e) => { e.preventDefault(); submit(form.dryRun); }} aria-labelledby="run-form-title">
        <h2 id="run-form-title" class="h5">One-off operation</h2>

        <OperationPicker bind:value={form.operation} />

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
          <Segmented options={RANGE_OPTIONS} value={form.rangeMode} name="range" ariaLabel="Date taken" onchange={(v) => (form.rangeMode = v)} />
          {#if form.rangeMode === "window"}
            <div class="grid gap-4 sm:grid-cols-2">
              <label class="label"><span class="label-text">From (optional)</span><input class="input" type="date" bind:value={form.from} /></label>
              <label class="label"><span class="label-text">To (optional)</span><input class="input" type="date" bind:value={form.to} /></label>
            </div>
            <p class="text-sm opacity-70">Set one or both. Dates are date taken, in UTC, and the to date is included in full.</p>
          {/if}
        </fieldset>

        <label class="label">
          <span class="label-text">Kind</span>
          <select class="select" bind:value={form.kind}>
            <option value="all">Photos and videos</option>
            <option value="photos">Photos only</option>
            <option value="videos">Videos only</option>
          </select>
        </label>

        <Toggle bind:checked={form.metadata} disabled={form.operation === "sync_metadata"} label={"Sync metadata" + (form.operation === "sync_metadata" ? " (always on for this operation)" : "")} />

        {#if form.operation !== "move"}
          <Toggle
            bind:checked={form.includeTrashed}
            label="Include assets in the source's trash"
            hint="Off by default. This only affects the source: an asset found only in the target's trash is still skipped, never uploaded again."
          />
        {/if}

        <div class="rounded-container p-3 {form.dryRun ? 'preset-tonal-success' : 'preset-tonal-warning'}">
          <Toggle bind:checked={form.dryRun}>
            <strong>Dry run</strong>: inspect and report only. {form.dryRun ? "No changes are made on either server." : "Off: this run will change the target" + (isMove ? " and trash source assets after verification." : ".")}
          </Toggle>
        </div>

        <p class="bg-surface-100-900 rounded-container p-3 text-sm" aria-live="polite"><strong>Summary:</strong> {summary}</p>

        {#if errors.length}
          <ul class="list-disc pl-5 text-sm text-error-500" role="alert">
            {#each errors as p (p)}<li>{p}</li>{/each}
          </ul>
        {/if}

        <div class="flex gap-2">
          <button class="btn {isMove && !form.dryRun ? 'preset-filled-error-500' : 'preset-filled-primary-500'}" type="submit" disabled={submitting || sameInstance}>
            {submitting ? "Starting…" : form.dryRun ? "Start dry run" : isMove ? "Review and start move…" : "Start run"}
          </button>
        </div>
      </form>

      <div class="flex min-w-0 flex-1 basis-72 flex-col gap-4 lg:max-w-sm">
        <RunSidePanels />
      </div>
    </div>
  {/if}

  <ConfirmDialog
    open={confirmOpen}
    title="Move assets from {source?.alias ?? 'the source'}?"
    confirmLabel="Move and trash on {source?.alias}"
    tone="danger"
    onconfirm={() => send(pendingDryRun)}
    oncancel={() => (confirmOpen = false)}
  >
    <p>
      Each asset is copied to <strong>{target?.alias}</strong> and checked there first. Only after it is verified (and its metadata synced, if enabled) is it sent to the
      <strong>trash</strong> of <strong>{source?.alias}</strong>. Nothing is permanently deleted, and you can restore trashed assets from that server.
    </p>
  </ConfirmDialog>

  {#if activeRunId}
    <hr class="border-surface-200-800" />
    <RunView runId={activeRunId} onrunreal={runReal} />
  {/if}
</div>
