<script lang="ts">
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import ProgressBar from "../ui/ProgressBar.svelte";
  import { opLabel, opTone, type StepNodeData } from "../lib/flow/ops.ts";

  let { data }: NodeProps = $props();
  const d = $derived(data as unknown as StepNodeData);
  const vertical = $derived(d.orientation === "vertical");
  const toneCls = { primary: "preset-tonal-primary", warning: "preset-tonal-warning", tertiary: "preset-tonal-tertiary" };
  const statusCls: Record<string, string> = {
    idle: "preset-tonal-surface", waiting: "preset-tonal-surface", running: "preset-tonal-primary", done: "preset-tonal-success",
    done_with_failures: "preset-tonal-warning", failed: "preset-tonal-error", cancelled: "preset-tonal-surface", not_run: "preset-tonal-surface",
  };
  const statusText = (s: string) => s.replaceAll("_", " ");
</script>

<div class="card preset-filled-surface-100-900 w-72 space-y-2 border border-surface-300-700 p-3">
  <Handle type="target" position={vertical ? Position.Top : Position.Left} />
  <div class="flex items-center justify-between gap-2">
    <span class="font-semibold">{d.position}. <span class="badge {toneCls[opTone(d.operation)]}">{opLabel(d.operation)}</span></span>
    {#if d.status !== "idle"}<span class="badge {statusCls[d.status]}">{statusText(d.status)}</span>{/if}
  </div>
  <div class="text-sm">{d.source} → {d.target}</div>
  {#if d.chips.length}
    <div class="flex flex-wrap gap-1">{#each d.chips as chip}<span class="badge preset-tonal-surface">{chip}</span>{/each}</div>
  {/if}
  {#if d.percent !== null}<ProgressBar percent={d.percent} label="Step progress" />{/if}
  {#each d.problems as p}<div class="text-xs text-error-600-400">{p}</div>{/each}
  <Handle type="source" position={vertical ? Position.Bottom : Position.Right} />
</div>
