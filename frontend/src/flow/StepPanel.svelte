<script lang="ts">
  import { SegmentedControl, Switch } from "@skeletonlabs/skeleton-svelte";
  import type { Instance } from "../lib/api.ts";
  import { OP_LABEL, type StepForm } from "../lib/jobs.ts";

  let {
    step,
    index,
    count,
    instances,
    problems,
    canDuplicate,
    onchange,
    onduplicate,
    onremove,
  }: {
    step: StepForm;
    index: number;
    count: number;
    instances: Instance[];
    problems: string[];
    canDuplicate: boolean;
    onchange: (patch: Partial<StepForm>) => void;
    onduplicate: () => void;
    onremove: () => void;
  } = $props();

  const optionLabel = (i: Instance) => `${i.alias}${i.lastCheck === null ? " · not checked" : i.lastCheck.ok ? " · OK" : " · check failed"}`;
  const isMove = $derived(step.operation === "move");
</script>

{#snippet toggle(label: string, checked: boolean, disabled: boolean, set: (v: boolean) => void, note?: string)}
  <Switch {checked} {disabled} onCheckedChange={(e) => set(e.checked)}>
    <Switch.Control><Switch.Thumb /></Switch.Control>
    <Switch.Label>{label}{#if note}<span class="block text-xs opacity-70">{note}</span>{/if}</Switch.Label>
    <Switch.HiddenInput />
  </Switch>
{/snippet}

<aside class="card preset-outlined-surface-200-800 space-y-4 p-4" aria-label="Step {index + 1} settings">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="font-semibold">Step {index + 1}</h3>
    <div class="flex gap-1">
      <button type="button" class="btn btn-sm preset-tonal-surface" disabled={!canDuplicate} onclick={onduplicate}>Duplicate</button>
      <button type="button" class="btn btn-sm preset-tonal-error" disabled={count === 1} onclick={onremove}>Remove</button>
    </div>
  </div>

  <div class="space-y-1">
    <span class="label-text">Operation</span>
    <SegmentedControl value={step.operation} onValueChange={(e) => e.value && onchange({ operation: e.value as StepForm["operation"] })}>
      <SegmentedControl.Control>
        <SegmentedControl.Indicator />
        {#each Object.entries(OP_LABEL) as [value, label] (value)}
          <SegmentedControl.Item {value}>
            <SegmentedControl.ItemText>{label}</SegmentedControl.ItemText>
            <SegmentedControl.ItemHiddenInput />
          </SegmentedControl.Item>
        {/each}
      </SegmentedControl.Control>
    </SegmentedControl>
    {#if isMove}<p class="text-sm opacity-80">Move verifies each asset on the target, then sends the source asset to the source's trash. Nothing is permanently deleted.</p>{/if}
  </div>

  <div class="grid gap-3">
    <label class="label"><span class="label-text">Source</span>
      <select class="select" value={step.sourceId} onchange={(e) => onchange({ sourceId: e.currentTarget.value })}>
        <option value="" disabled>Choose…</option>
        {#each instances as inst (inst.id)}<option value={inst.id}>{optionLabel(inst)}</option>{/each}
      </select>
    </label>
    <label class="label"><span class="label-text">Target</span>
      <select class="select" value={step.targetId} onchange={(e) => onchange({ targetId: e.currentTarget.value })}>
        <option value="" disabled>Choose…</option>
        {#each instances as inst (inst.id)}<option value={inst.id}>{optionLabel(inst)}</option>{/each}
      </select>
    </label>
  </div>

  <div class="space-y-2">
    <label class="label"><span class="label-text">Date taken</span>
      <select class="select" value={step.rangeMode} onchange={(e) => onchange({ rangeMode: e.currentTarget.value as StepForm["rangeMode"] })}>
        <option value="all">All assets</option>
        <option value="window">Date window</option>
        <option value="lastDays">Last N days</option>
      </select>
    </label>
    {#if step.rangeMode === "window"}
      <div class="grid gap-3">
        <label class="label"><span class="label-text">From (optional)</span><input class="input" type="date" value={step.from} onchange={(e) => onchange({ from: e.currentTarget.value })} /></label>
        <label class="label"><span class="label-text">To (optional)</span><input class="input" type="date" value={step.to} onchange={(e) => onchange({ to: e.currentTarget.value })} /></label>
      </div>
      <p class="text-xs opacity-70">Set one or both. A fixed window suits a one-off job; a recurring job usually wants all assets or the last N days.</p>
    {:else if step.rangeMode === "lastDays"}
      <label class="label max-w-xs"><span class="label-text">Days back from the run time</span><input class="input" type="number" min="1" max="36500" step="1" value={step.lastDays} oninput={(e) => onchange({ lastDays: e.currentTarget.value })} /></label>
    {/if}
  </div>

  <label class="label"><span class="label-text">Kind</span>
    <select class="select" value={step.kind} onchange={(e) => onchange({ kind: e.currentTarget.value as StepForm["kind"] })}>
      <option value="all">Photos and videos</option>
      <option value="photos">Photos only</option>
      <option value="videos">Videos only</option>
    </select>
  </label>

  <div class="space-y-3">
    {@render toggle("Sync metadata", step.metadata, step.operation === "sync_metadata", (v) => onchange({ metadata: v }), step.operation === "sync_metadata" ? "Always on for this operation" : undefined)}
    {@render toggle("Add to matching albums", step.includeAlbums, !step.metadata, (v) => onchange({ includeAlbums: v }), "By exact name, additive")}
    {@render toggle("Create albums missing on the target", step.createMissingAlbums, !step.metadata || !step.includeAlbums, (v) => onchange({ createMissingAlbums: v }))}
    {@render toggle("Sync tags", step.includeTags, !step.metadata, (v) => onchange({ includeTags: v }), "Additive")}
    {@render toggle("Copy crop, rotate and mirror edits", step.includeEdits, !step.metadata, (v) => onchange({ includeEdits: v }), "Only to target assets with no edits; needs asset.edit permissions")}
    {@render toggle(
      "Include assets in the source's trash",
      step.includeTrashed,
      isMove,
      (v) => onchange({ includeTrashed: v }),
      isMove ? "Not available for move" : "Assets found only in the target's trash are still skipped.",
    )}
  </div>

  <div class="grid gap-3">
    <label class="label"><span class="label-text">If some assets fail in this step</span>
      <select class="select" value={step.onFailure} onchange={(e) => onchange({ onFailure: e.currentTarget.value as StepForm["onFailure"] })}>
        <option value="continue">Continue with the next step</option>
        <option value="stop">Stop the job</option>
      </select>
    </label>
    <label class="label"><span class="label-text">If this step cannot run (server down, key rejected)</span>
      <select class="select" value={step.onError} onchange={(e) => onchange({ onError: e.currentTarget.value as StepForm["onError"] })}>
        <option value="stop">Stop the job; later steps are not run</option>
        <option value="continue">Continue anyway</option>
      </select>
    </label>
  </div>

  {#if problems.length}
    <ul class="list-disc pl-5 text-sm text-warning-700-300">{#each problems as p (p)}<li>{p}</li>{/each}</ul>
  {/if}
</aside>
