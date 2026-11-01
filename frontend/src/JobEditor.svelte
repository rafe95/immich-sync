<script lang="ts">
  import { ApiError, type Instance } from "./lib/api.ts";
  import { api } from "./lib/session.svelte.ts";
  import { buildJobBody, defaultStep, duplicateStep, jobSnapshot, MAX_STEPS, normalizeStepForm, stepFromRecord, type JobRecord, type StepForm } from "./lib/jobs.ts";
  import type { Operation } from "./lib/runs.ts";
  import { reorderByY, scheduleWarning, stepProblems } from "./lib/flow/pipeline.ts";
  import JobPipeline from "./flow/JobPipeline.svelte";
  import StepPanel from "./flow/StepPanel.svelte";
  import StepPalette from "./flow/StepPalette.svelte";

  let {
    job,
    instances,
    onsaved,
    oncancel,
    oneditschedule,
    onstart,
  }: {
    job: JobRecord | null;
    instances: Instance[];
    onsaved: (job: JobRecord) => void;
    oncancel: () => void;
    oneditschedule?: () => void;
    /** Dry run / Run now for the saved job; offered only for an existing job with no unsaved changes. */
    onstart?: (job: JobRecord, dryRun: boolean) => void;
  } = $props();

  // Mounted fresh per edit, so the initial value is what we want.
  // svelte-ignore state_referenced_locally
  let name = $state(job?.name ?? "");
  // svelte-ignore state_referenced_locally
  let steps = $state<StepForm[]>(job ? job.steps.map(stepFromRecord) : [defaultStep({ sourceId: instances.find((i) => i.isDefault)?.id ?? "" })]);
  let errors = $state<string[]>([]);
  let saving = $state(false);
  let announce = $state("");
  // svelte-ignore state_referenced_locally
  const initialSnapshot = jobSnapshot(name, steps);
  const dirty = $derived(jobSnapshot(name, steps) !== initialSnapshot);

  // svelte-ignore state_referenced_locally
  let selectedKey = $state<string | null>(steps[0]?.key ?? null);
  const selectedIndex = $derived(steps.findIndex((s) => s.key === selectedKey));
  const selected = $derived(selectedIndex >= 0 ? steps[selectedIndex]! : null);
  const warning = $derived(scheduleWarning(job?.schedule ?? null, steps));
  const allProblems = $derived([...steps.flatMap((s, i) => stepProblems(s, i, instances)), ...(warning ? [warning] : [])]);

  function update(i: number, patch: Partial<StepForm>) {
    steps[i] = normalizeStepForm({ ...steps[i]!, ...patch });
  }
  function remove(i: number) {
    steps = steps.filter((_, k) => k !== i);
    selectedKey = steps[Math.min(i, steps.length - 1)]?.key ?? null;
    announce = `Step ${i + 1} removed.`;
  }
  function addAt(operation: Operation, index: number) {
    if (steps.length >= MAX_STEPS) return;
    const prev = steps[index - 1];
    const step = normalizeStepForm(defaultStep({ operation, sourceId: prev?.targetId ?? "", targetId: "" }));
    steps = [...steps.slice(0, index), step, ...steps.slice(index)];
    selectedKey = step.key;
    announce = `Step added at position ${index + 1}.`;
  }
  function reorder(key: string, y: number) {
    const next = reorderByY(steps, key, y);
    steps = next;
    announce = `Step moved to position ${next.findIndex((s) => s.key === key) + 1} of ${next.length}.`;
  }
  function duplicate(i: number) {
    const copy = duplicateStep(steps[i]!);
    steps = [...steps.slice(0, i + 1), copy, ...steps.slice(i + 1)];
    selectedKey = copy.key;
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

<form class="space-y-4" onsubmit={save} aria-label={job ? `Edit job ${job.name}` : "New job"}>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div class="min-w-0 flex-1 space-y-1">
      <p class="text-sm opacity-70"><button type="button" class="anchor" onclick={oncancel}>Jobs</button> / {job ? "Edit" : "New"}</p>
      <label class="sr-only" for="job-name">Job name</label>
      <input id="job-name" class="input w-full max-w-xl text-xl font-bold"placeholder="Job name" bind:value={name} maxlength="100" required autocomplete="off" />
    </div>
    <div class="flex flex-wrap gap-2">
      {#if job && onstart}
        <button type="button" class="btn preset-tonal-surface" disabled={dirty || saving} title={dirty ? "Save your changes first" : undefined} onclick={() => onstart(job, true)}>Dry run</button>
        <button type="button" class="btn preset-tonal-primary" disabled={dirty || saving} title={dirty ? "Save your changes first" : undefined} onclick={() => onstart(job, false)}>Run now</button>
      {/if}
      <button class="btn preset-filled-primary-500" type="submit" disabled={saving}>{saving ? "Saving…" : job ? "Save job" : "Create job"}</button>
      <button class="btn preset-tonal-surface" type="button" onclick={oncancel}>Cancel</button>
    </div>
  </div>

  <p class="sr-only" role="status" aria-live="polite">{announce}</p>

  {#if errors.length}
    <ul class="list-disc pl-5 text-sm text-error-500" role="alert">{#each errors as p (p)}<li>{p}</li>{/each}</ul>
  {/if}

  <div class="grid gap-4 lg:grid-cols-[12rem_minmax(0,1fr)_22rem]">
    <div class="space-y-4">
      <StepPalette disabled={steps.length >= MAX_STEPS} onadd={(op) => addAt(op, steps.length)} />
      <section class="card preset-outlined-surface-200-800 space-y-2 p-3" aria-label="Checks">
        <h3 class="text-xs font-semibold tracking-wide uppercase opacity-70">Checks</h3>
        <ul class="space-y-1.5 text-sm">
          <li class="flex gap-2"><span class="font-bold text-success-700-300" aria-hidden="true">✓</span>{steps.length} of {MAX_STEPS} steps</li>
          {#each allProblems as p (p)}<li class="flex gap-2 text-warning-800-200"><span class="font-bold" aria-hidden="true">!</span>{p}</li>{/each}
          {#if !allProblems.length}<li class="flex gap-2"><span class="font-bold text-success-700-300" aria-hidden="true">✓</span>No problems found.</li>{/if}
        </ul>
      </section>
    </div>

    <div class="min-w-0 space-y-2">
      <JobPipeline
        {steps}
        schedule={job?.schedule ?? null}
        {instances}
        {selectedKey}
        onselect={(k) => (selectedKey = k)}
        onadd={addAt}
        onreorder={reorder}
        oneditschedule={job && oneditschedule ? oneditschedule : undefined}
      />
      {#if job && oneditschedule}<p class="text-xs opacity-70">Editing the schedule leaves this form; unsaved step changes are discarded.</p>{/if}
    </div>

    <div>
      {#if selected}
        <StepPanel
          step={selected}
          index={selectedIndex}
          count={steps.length}
          {instances}
          problems={stepProblems(selected, selectedIndex, instances)}
          canDuplicate={steps.length < MAX_STEPS}
          onchange={(patch) => update(selectedIndex, patch)}
          onduplicate={() => duplicate(selectedIndex)}
          onremove={() => remove(selectedIndex)}
        />
      {:else}
        <p class="text-sm opacity-70">Select a step to edit its settings.</p>
      {/if}
    </div>
  </div>
</form>
