<script lang="ts">
  import { ApiError, type Instance } from "./lib/api.ts";
  import { api } from "./lib/session.svelte.ts";
  import { buildJobBody, defaultStep, duplicateStep, MAX_STEPS, normalizeStepForm, stepFromRecord, type JobRecord, type StepForm } from "./lib/jobs.ts";
  import type { Operation } from "./lib/runs.ts";
  import { reorderByY, scheduleWarning, stepProblems } from "./lib/flow/pipeline.ts";
  import JobPipeline from "./flow/JobPipeline.svelte";
  import StepPanel from "./flow/StepPanel.svelte";

  let {
    job,
    instances,
    onsaved,
    oncancel,
    oneditschedule,
  }: { job: JobRecord | null; instances: Instance[]; onsaved: (job: JobRecord) => void; oncancel: () => void; oneditschedule?: () => void } = $props();

  // Mounted fresh per edit, so the initial value is what we want.
  // svelte-ignore state_referenced_locally
  let name = $state(job?.name ?? "");
  // svelte-ignore state_referenced_locally
  let steps = $state<StepForm[]>(job ? job.steps.map(stepFromRecord) : [defaultStep({ sourceId: instances.find((i) => i.isDefault)?.id ?? "" })]);
  let errors = $state<string[]>([]);
  let saving = $state(false);
  let announce = $state("");

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

<form class="card preset-outlined-surface-200-800 max-w-6xl space-y-4 p-4" onsubmit={save} aria-labelledby="job-form-title">
  <h2 id="job-form-title" class="h5">{job ? `Edit "${job.name}"` : "New job"}</h2>

  <label class="label max-w-md">
    <span class="label-text">Name</span>
    <input class="input" bind:value={name} maxlength="100" required autocomplete="off" />
  </label>

  <p class="sr-only" role="status" aria-live="polite">{announce}</p>

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

  <section class="card preset-tonal-surface space-y-1 p-3" aria-label="Checks">
    <h3 class="font-semibold">Checks</h3>
    {#if allProblems.length}
      <ul class="list-disc pl-5 text-sm text-warning-700-300">{#each allProblems as p (p)}<li>{p}</li>{/each}</ul>
    {:else}
      <p class="text-sm">No problems found.</p>
    {/if}
  </section>

  {#if errors.length}
    <ul class="list-disc pl-5 text-sm text-error-500" role="alert">{#each errors as p (p)}<li>{p}</li>{/each}</ul>
  {/if}

  <div class="flex flex-wrap gap-2">
    <button class="btn preset-filled-primary-500" type="submit" disabled={saving}>{saving ? "Saving…" : job ? "Save job" : "Create job"}</button>
    <button class="btn preset-tonal-surface" type="button" onclick={oncancel}>Cancel</button>
  </div>
</form>
