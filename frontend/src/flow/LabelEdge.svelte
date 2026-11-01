<script lang="ts">
  import { BaseEdge, EdgeLabel, getBezierPath, type EdgeProps } from "@xyflow/svelte";
  import type { LabelEdgeData } from "../lib/flow/ops.ts";

  let { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps = $props();
  const d = $derived(data as unknown as LabelEdgeData);
  const path = $derived(getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }));
  const stroke = { primary: "var(--color-primary-500)", warning: "var(--color-warning-500)", tertiary: "var(--color-tertiary-500)", neutral: "var(--color-surface-500)" };
  const badge = { primary: "preset-tonal-primary", warning: "preset-tonal-warning", tertiary: "preset-tonal-tertiary", neutral: "preset-tonal-surface" };
  const dash = $derived(d.style === "muted" ? "4 4" : d.style === "running" ? "8 4" : undefined);
</script>

<BaseEdge
  {id}
  path={path[0]}
  style="stroke: {d.style === 'warning' ? stroke.warning : stroke[d.tone]}; stroke-width: {selected ? 3 : 2}; {dash ? `stroke-dasharray: ${dash};` : ''} {d.style === 'muted' ? 'opacity: .6;' : ''}"
/>
<EdgeLabel x={path[1]} y={path[2]} class="badge {badge[d.tone]} nodrag nopan {d.onselect ? 'cursor-pointer' : ''}" onclick={() => d.onselect?.()}>{d.icon === "on-error" ? "⚠ " : ""}{d.label}</EdgeLabel>
