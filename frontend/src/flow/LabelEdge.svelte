<script lang="ts">
  import { BaseEdge, EdgeLabel, getBezierPath, type EdgeProps } from "@xyflow/svelte";
  import type { LabelEdgeData } from "../lib/flow/ops.ts";

  let { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps = $props();
  const d = $derived(data as unknown as LabelEdgeData);
  const LANE_GAP = 18;
  const shift = $derived((d.lane ?? 0) * LANE_GAP);
  const path = $derived(getBezierPath({ sourceX, sourceY: sourceY + shift, targetX, targetY: targetY + shift, sourcePosition, targetPosition }));
  const stroke = { primary: "var(--color-primary-500)", warning: "var(--color-warning-500)", tertiary: "var(--color-tertiary-500)", neutral: "var(--color-surface-500)" };
  const dot = { primary: "bg-primary-500", warning: "bg-warning-500", tertiary: "bg-tertiary-500", neutral: "bg-surface-500" };
  const dash = $derived(d.style === "muted" ? "4 4" : d.style === "running" ? "8 4" : undefined);
</script>

<BaseEdge
  {id}
  path={path[0]}
  style="stroke: {d.style === 'warning' ? stroke.warning : stroke[d.tone]}; stroke-width: {selected ? 3 : 2}; {dash ? `stroke-dasharray: ${dash};` : ''} {d.style === 'muted' ? 'opacity: .6;' : ''}"
/>
<EdgeLabel
  x={path[1]}
  y={path[2]}
  class="flex items-center gap-1.5 rounded-full border bg-surface-50-950 px-2.5 py-1 text-xs font-medium shadow-sm nodrag nopan {selected ? 'border-primary-500' : 'border-surface-300-700'} {d.onselect ? 'cursor-pointer' : ''}"
  onclick={() => d.onselect?.()}
><span class="h-2 w-2 shrink-0 rounded-full {dot[d.tone]}"></span>{d.icon === "on-error" ? "⚠ " : ""}{d.label}</EdgeLabel>
