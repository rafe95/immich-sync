<script lang="ts">
  import { BaseEdge, EdgeLabel, getBezierPath, type EdgeProps } from "@xyflow/svelte";
  import type { LabelEdgeData } from "../lib/flow/ops.ts";

  let { id, markerEnd, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps = $props();
  const d = $derived(data as unknown as LabelEdgeData);
  const LANE_GAP = 18;
  const shift = $derived((d.lane ?? 0) * LANE_GAP);
  const path = $derived(getBezierPath({ sourceX, sourceY: sourceY + shift, targetX, targetY: targetY + shift, sourcePosition, targetPosition }));
  const stroke = { primary: "var(--color-primary-500)", warning: "var(--color-warning-500)", tertiary: "var(--color-tertiary-500)", neutral: "var(--color-surface-500)" };
  const dot = { primary: "bg-primary-500", warning: "bg-warning-500", tertiary: "bg-tertiary-500", neutral: "bg-surface-500" };
  const dash = $derived(d.style === "muted" ? "4 4" : d.style === "running" ? "8 4" : undefined);
  const pillTone = {
    primary: "border-primary-500 text-primary-700-300",
    warning: "border-warning-500 text-warning-700-300",
    tertiary: "border-tertiary-500 text-tertiary-700-300",
    neutral: "border-surface-400-600",
  };
  const pill = $derived(
    d.style === "running"
      ? "border-primary-500 bg-primary-500 text-white font-semibold"
      : `bg-surface-50-950 ${d.style === "muted" ? "border-surface-300-700 opacity-80" : pillTone[d.style === "warning" ? "warning" : d.tone]}`,
  );
</script>

<BaseEdge
  {id}
  path={path[0]}
  markerEnd={markerEnd}
  style="stroke: {d.style === 'warning' ? stroke.warning : stroke[d.tone]}; stroke-width: {selected ? 3 : 2}; {dash ? `stroke-dasharray: ${dash};` : ''} {d.style === 'running' ? 'animation: immich-dash .9s linear infinite;' : ''} {d.style === 'muted' ? 'opacity: .6;' : ''}"
/>
<EdgeLabel
  x={path[1]}
  y={path[2]}
  class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium shadow-sm nodrag nopan {pill} {selected ? 'ring-2 ring-primary-500/40' : ''} {d.onselect ? 'cursor-pointer' : ''}"
  onclick={() => d.onselect?.()}
>{#if d.style !== "running"}<span class="h-2 w-2 shrink-0 rounded-full {dot[d.tone]}"></span>{/if}{d.icon === "on-error" ? "⚠ " : ""}{d.label}</EdgeLabel>
