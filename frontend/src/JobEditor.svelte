<script lang="ts">
  import { ApiError, type Instance } from "./lib/api.ts";
  import { api } from "./lib/session.svelte.ts";
  import { buildJobBody, defaultStep, duplicateStep, MAX_STEPS, moveItem, normalizeStepForm, OP_LABEL, stepFromRecord, stepSummary, validateStep, type JobRecord, type StepForm } from "./lib/jobs.ts";

  let { job, instances, onsaved, oncancel }: { job: JobRecord | null; instances: Instance[]; onsaved: (job: JobRecord) => void; oncancel: () => void } = $props();

  // Mounted fresh per edit, so the initial value is what we want.
  // svelte-ignore state_referenced_locally
  let name = $state(job?.name ?? "");
  // svelte-ignore state_referenced_locally
  let steps = $state<StepForm[]>(job ? job.steps.map(stepFromRecord) : [defaultStep({ sourceId: instances.find((i) => i.isDefault)?.id ?? "" })]);
  let errors = $state<string[]>([]);
  let saving = $state(false);
  let announce = $state("");

  const alias = (id: string) => instances.find((i) => i.id === id)?.alias ?? "…";
  const optionLabel = (i: Instance) => `${i.alias}${i.lastCheck === null ? " · not checked" : i.lastCheck.ok ? " · OK" : " · check failed"}`;

  function update(i: number, patch: Partial<StepForm>) {
    steps[i] = normalizeStepForm({ ...steps[i]!, ...patch });
  }
  function move(i: number, to: number) {
    steps = moveItem(steps, i, to);
    announce = `Step moved to position ${to + 1} of ${steps.length}.`;
  }
  function remove(i: number) {
    steps = steps.filter((_, k) => k !== i);
    announce = `Step ${i + 1} removed.`;
  }
  function add() {
    const last = steps.at(-1);
    steps = [...steps, defaultStep({ sourceId: last?.targetId ?? "", targetId: "" })];
  }
  function duplicate(i: number) {
    steps = [...steps.slice(0, i + 1), duplicateStep(steps[i]!), ...steps.slice(i + 1)];
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    errors = [];
    const built = buildJobBody(name, steps);
    if (!built.ok) {
      errors = built.problems;
      return;
    }
    saving = true;
    try {
      onsaved(job ? await api.updateJob(job.id, built.body) : await api.createJob(built.body));
    } catch (err) {
      errors = err instanceof ApiError && err.problems.length ? err.problems : [err instanceof Error ? err.message : String(err)];
    } finally {
      saving = false;
    }
  }
</script>

<form class="card preset-outlined-surface-200-800 max-w-4xl space-y-4 p-4" onsubmit={save} aria-labelledby="job-form-title">
  <h2 id="job-form-title" class="h5">{job ? `Edit "${job.name}"` : "New job"}</h2>

  <label class="label max-w-md">
    <span class="label-text">Name</span>
    <input class="input" bind:value={name} maxlength="100" required autocomplete="off" />
  </label>

  <p class="sr-only" role="status" aria-live="polite">{announce}</p>

  <ol class="space-y-4">
    {#each steps as s, i (s.key)}
      {@const problems = validateStep(s, i)}
      <li class="card preset-tonal-surface space-y-3 p-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="font-semibold">Step {i + 1}</h3>
          <div class="flex flex-wrap gap-1">
            <button type="button" class="btn btn-sm preset-tonal-surface" disabled={i === 0} onclick={() => move(i, i - 1)} aria-label="Move step {i + 1} up">Up</button>
            <button type="button" class="btn btn-sm preset-tonal-surface" disabled={i === steps.length - 1} onclick={() => move(i, i + 1)} aria-label="Move step {i + 1} down">Down</button>
            <button type="button" class="btn btn-sm preset-tonal-surface" disabled={steps.length >= MAX_STEPS} onclick={() => duplicate(i)} aria-label="Duplicate step {i + 1}">Duplicate</button>
            <button type="button" class="btn btn-sm preset-tonal-error" disabled={steps.length === 1} onclick={() => remove(i)} aria-label="Remove step {i + 1}">Remove</button>
          </div>
        </div>
        <p class="text-sm opacity-80">{stepSummary(s, alias)}</p>

        <fieldset class="space-y-1">
          <legend class="label-text">Operation</legend>
          <div class="flex flex-wrap gap-4">
            {#each Object.entries(OP_LABEL) as [value, label] (value)}
              <label class="flex items-center gap-2"><input class="radio" type="radio" name="op-{s.key}" {value} checked={s.operation === value} onchange={() => update(i, { operation: value as StepForm["operation"] })} /> {label}</label>
            {/each}
          </div>
          {#if s.operation === "move"}
            <p class="text-sm opacity-80">Move verifies each asset on the target, then sends the source asset to the source's trash. Nothing is permanently deleted.</p>
          {/if}
        </fieldset>

        <div class="grid gap-3 sm:grid-cols-2">
          <label class="label"><span class="label-text">Source</span>
            <select class="select" value={s.sourceId} onchange={(e) => update(i, { sourceId: e.currentTarget.value })} required>
              <option value="" disabled>Choose…</option>
              {#each instances as inst (inst.id)}<option value={inst.id}>{optionLabel(inst)}</option>{/each}
            </select>
          </label>
          <label class="label"><span class="label-text">Target</span>
            <select class="select" value={s.targetId} onchange={(e) => update(i, { targetId: e.currentTarget.value })} required>
              <option value="" disabled>Choose…</option>
              {#each instances as inst (inst.id)}<option value={inst.id}>{optionLabel(inst)}</option>{/each}
            </select>
          </label>
        </div>

        <fieldset class="space-y-2">
          <legend class="label-text">Date taken</legend>
          <div class="flex flex-wrap gap-4">
            <label class="flex items-center gap-2"><input class="radio" type="radio" name="range-{s.key}" value="all" bind:group={s.rangeMode} /> All assets</label>
            <label class="flex items-center gap-2"><input class="radio" type="radio" name="range-{s.key}" value="window" bind:group={s.rangeMode} /> Date window</label>
            <label class="flex items-center gap-2"><input class="radio" type="radio" name="range-{s.key}" value="lastDays" bind:group={s.rangeMode} /> Last N days</label>
          </div>
          {#if s.rangeMode === "window"}
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="label"><span class="label-text">From (optional)</span><input class="input" type="date" bind:value={s.from} /></label>
              <label class="label"><span class="label-text">To (optional)</span><input class="input" type="date" bind:value={s.to} /></label>
            </div>
            <p class="text-xs opacity-70">Set one or both. A fixed window suits a one-off job; a recurring job usually wants all assets or the last N days.</p>
          {:else if s.rangeMode === "lastDays"}
            <label class="label max-w-xs"><span class="label-text">Days back from the run time</span><input class="input" type="number" min="1" max="36500" step="1" bind:value={s.lastDays} /></label>
          {/if}
        </fieldset>

        <label class="label max-w-xs"><span class="label-text">Kind</span>
          <select class="select" bind:value={s.kind}>
            <option value="all">Photos and videos</option>
            <option value="photos">Photos only</option>
            <option value="videos">Videos only</option>
          </select>
        </label>

        <div class="space-y-2">
          <label class="flex items-center gap-2">
            <input class="checkbox" type="checkbox" checked={s.metadata} disabled={s.operation === "sync_metadata"} onchange={(e) => update(i, { metadata: e.currentTarget.checked })} />
            <span>Sync metadata{s.operation === "sync_metadata" ? " (always on for this operation)" : ""}</span>
          </label>
          <div class="ml-6 space-y-1">
            <label class="flex items-center gap-2"><input class="checkbox" type="checkbox" checked={s.includeAlbums} disabled={!s.metadata} onchange={(e) => update(i, { includeAlbums: e.currentTarget.checked })} /> Add to matching albums (by exact name, additive)</label>
            <label class="ml-6 flex items-center gap-2"><input class="checkbox" type="checkbox" checked={s.createMissingAlbums} disabled={!s.metadata || !s.includeAlbums} onchange={(e) => update(i, { createMissingAlbums: e.currentTarget.checked })} /> Create albums missing on the target</label>
            <label class="flex items-center gap-2"><input class="checkbox" type="checkbox" checked={s.includeTags} disabled={!s.metadata} onchange={(e) => update(i, { includeTags: e.currentTarget.checked })} /> Sync tags (additive)</label>
          </div>
          {#if s.operation !== "move"}
            <label class="flex items-start gap-2">
              <input class="checkbox mt-1" type="checkbox" checked={s.includeTrashed} onchange={(e) => update(i, { includeTrashed: e.currentTarget.checked })} />
              <span>Include assets in the source's trash <span class="block text-xs opacity-70">Never offered for a move. Assets found only in the target's trash are still skipped.</span></span>
            </label>
          {/if}
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <label class="label"><span class="label-text">If some assets fail in this step</span>
            <select class="select" bind:value={s.onFailure}>
              <option value="continue">Continue with the next step</option>
              <option value="stop">Stop the job</option>
            </select>
          </label>
          <label class="label"><span class="label-text">If this step cannot run (server down, key rejected)</span>
            <select class="select" bind:value={s.onError}>
              <option value="stop">Stop the job; later steps are not run</option>
              <option value="continue">Continue anyway</option>
            </select>
          </label>
        </div>

        {#if problems.length}
          <ul class="list-disc pl-5 text-sm text-warning-700-300">{#each problems as p (p)}<li>{p}</li>{/each}</ul>
        {/if}
      </li>
    {/each}
  </ol>

  <button type="button" class="btn preset-tonal-primary" disabled={steps.length >= MAX_STEPS} onclick={add}>Add step</button>

  {#if errors.length}
    <ul class="list-disc pl-5 text-sm text-error-500" role="alert">{#each errors as p (p)}<li>{p}</li>{/each}</ul>
  {/if}

  <div class="flex flex-wrap gap-2">
    <button class="btn preset-filled-primary-500" type="submit" disabled={saving}>{saving ? "Saving…" : job ? "Save job" : "Create job"}</button>
    <button class="btn preset-tonal-surface" type="button" onclick={oncancel}>Cancel</button>
  </div>
</form>
