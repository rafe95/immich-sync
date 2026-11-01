<script lang="ts">
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import type { InstanceNodeData } from "../lib/flow/ops.ts";

  let { data }: NodeProps = $props();
  const d = $derived(data as unknown as InstanceNodeData);
  const dotCls = { ok: "bg-success-500", warn: "bg-warning-500", error: "bg-error-500" };
  const textCls = { ok: "text-success-700-300", warn: "text-warning-700-300", error: "text-error-700-300" };
  const borderCls = { ok: "border-surface-300-700", warn: "border-warning-500", error: "border-error-500" };
  const activityText = { lock: "Write lock", reading: "Reading for", waiting: "Waiting for" };
  const activityLabel = (a: NonNullable<InstanceNodeData["activity"]>) => (a.kind === "lock" ? `Write lock · ${a.job}` : `${activityText[a.kind]} ${a.job}`);
</script>

<div
  class="card preset-filled-surface-50-950 w-64 overflow-hidden border shadow-sm {d.selected ? 'border-2 border-primary-500 ring-4 ring-primary-500/20' : borderCls[d.health.tone]}"
>
  <Handle type="target" position={Position.Left} />
  <div class="flex items-center gap-2 border-b border-surface-200-800 px-3 py-2.5">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" class="shrink-0 opacity-70"><rect x="3" y="4" width="18" height="7" rx="2"></rect><rect x="3" y="13" width="18" height="7" rx="2"></rect><path d="M7 7.5h.01M7 16.5h.01"></path></svg>
    <span class="truncate text-sm font-semibold">{d.alias}</span>
    {#if d.isDefault}<span class="rounded bg-surface-200-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase">default</span>{/if}
    <span class="ml-auto h-2 w-2 shrink-0 rounded-full {dotCls[d.health.tone]}" title={d.health.label} role="img" aria-label={d.health.label}></span>
  </div>
  <div class="grid grid-cols-2 gap-x-2 gap-y-1.5 px-3 py-2.5 text-xs">
    <span class="opacity-60">Version</span><span>{d.version ? `v${d.version.replace(/^v/, "")}` : "Unknown"}</span>
    <span class="opacity-60">Status</span><span class="font-medium {textCls[d.health.tone]}">{d.health.label}</span>
    {#if d.checkedAt}<span class="opacity-60">Checked</span><span>{new Date(d.checkedAt).toLocaleString()}</span>{/if}
  </div>
  {#if d.activity}
    <div class="mx-3 mb-2.5 truncate rounded px-2 py-1 text-[11px] font-semibold {d.activity.kind === 'lock' ? 'preset-tonal-warning' : 'preset-tonal-primary'}" title={d.activity.job}>
      {#if d.activity.kind === "lock"}<span aria-hidden="true">🔒 </span>{/if}{activityLabel(d.activity)}
    </div>
  {/if}
  <Handle type="source" position={Position.Right} />
</div>
