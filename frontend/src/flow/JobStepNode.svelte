<script lang="ts">
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import { opLabel, opTone, type StepNodeData } from "../lib/flow/ops.ts";

  // Pipeline-only step card (the run diagram keeps StepNode): header band with the step number and operation colour.
  let { data, selected }: NodeProps = $props();
  const d = $derived(data as unknown as StepNodeData);
  const tone = $derived(opTone(d.operation));
  const band = { primary: "preset-tonal-primary", warning: "preset-tonal-warning", tertiary: "preset-tonal-tertiary" };
  const num = { primary: "preset-filled-primary-500", warning: "preset-filled-warning-500", tertiary: "preset-filled-tertiary-500" };
  const ring = { primary: "border-primary-500", warning: "border-warning-500", tertiary: "border-tertiary-500" };
</script>

<div class="card preset-filled-surface-50-950 w-72 overflow-hidden border-2 {selected ? ring[tone] : d.problems.length ? 'border-warning-500' : 'border-surface-300-700'}">
  <Handle type="target" position={Position.Top} />
  <div class="flex items-center gap-2 px-3 py-2 {band[tone]}">
    <span class="badge-icon size-6 rounded-md text-xs font-bold {num[tone]}">{d.position}</span>
    <span class="font-bold">{opLabel(d.operation)}</span>
    {#if d.operation === "move"}<span class="ml-auto text-xs font-semibold">Verify before trash</span>{/if}
  </div>
  <div class="space-y-2 p-3">
    <div class="flex flex-wrap items-center gap-2 text-sm font-semibold">
      <span class="rounded-md bg-surface-200-800 px-2 py-0.5">{d.source}</span>
      <span aria-hidden="true">→</span>
      <span class="rounded-md bg-surface-200-800 px-2 py-0.5">{d.target}</span>
    </div>
    {#if d.chips.length}
      <div class="flex flex-wrap gap-1.5">{#each d.chips as chip (chip)}<span class="rounded-full border border-surface-300-700 px-2 py-0.5 text-xs">{chip}</span>{/each}</div>
    {/if}
    {#each d.problems as p (p)}<div class="rounded-md bg-warning-100-900 px-2 py-1 text-xs text-warning-800-200">{p}</div>{/each}
  </div>
  <Handle type="source" position={Position.Bottom} />
</div>
