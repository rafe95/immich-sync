<script lang="ts">
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import type { InstanceNodeData } from "../lib/flow/ops.ts";

  let { data }: NodeProps = $props();
  const d = $derived(data as unknown as InstanceNodeData);
  const healthCls = { ok: "preset-tonal-success", warn: "preset-tonal-warning", error: "preset-tonal-error" };
  const activityText = { lock: "Write lock", reading: "Reading", waiting: "Waiting" };
</script>

<div class="card preset-filled-surface-100-900 w-56 space-y-1 border p-3 {d.selected ? 'border-primary-500' : 'border-surface-300-700'}">
  <Handle type="target" position={Position.Left} />
  <div class="flex items-center justify-between gap-2">
    <span class="truncate font-semibold">{d.alias}</span>
    {#if d.isDefault}<span class="badge preset-tonal-primary">default</span>{/if}
  </div>
  <div class="text-xs opacity-70">{d.version ? `Immich ${d.version}` : "Version unknown"}</div>
  <div class="flex flex-wrap gap-1">
    <span class="badge {healthCls[d.health.tone]}">{d.health.label}</span>
    {#if d.activity}<span class="badge preset-tonal-warning" title={d.activity.job}>{activityText[d.activity.kind]} · {d.activity.job}</span>{/if}
  </div>
  {#if d.checkedAt}<div class="text-xs opacity-60">Checked {new Date(d.checkedAt).toLocaleString()}</div>{/if}
  <Handle type="source" position={Position.Right} />
</div>
