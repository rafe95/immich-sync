<script lang="ts">
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import type { PreflightNodeData } from "../lib/flow/run.ts";

  let { data }: NodeProps = $props();
  const d = $derived(data as unknown as PreflightNodeData);
  const label = { waiting_for_lock: "Waiting for lock", checking: "Checking instances", passed: "Checks passed", failed: "Checks failed" };
  const cls = { waiting_for_lock: "preset-tonal-surface", checking: "preset-tonal-primary", passed: "preset-tonal-success", failed: "preset-tonal-error" };
  const frame = { waiting_for_lock: "border-surface-300-700", checking: "border-primary-500", passed: "border-success-500", failed: "border-error-500" };
</script>

<div class="card preset-filled-surface-50-950 w-52 space-y-1.5 border p-3 {frame[d.state]}">
  <div class="flex items-center gap-2 text-sm font-bold">
    {#if d.state === "passed"}
      <span class="flex size-5 items-center justify-center rounded-full bg-success-500 text-xs text-white" role="img" aria-label="passed">✓</span>
    {:else if d.state === "failed"}
      <span class="flex size-5 items-center justify-center rounded-full bg-error-500 text-xs text-white" role="img" aria-label="failed">✕</span>
    {/if}
    Preflight
  </div>
  {#if d.state === "passed"}
    <div class="text-xs opacity-80">
      {d.instances} {d.instances === 1 ? "instance" : "instances"} checked
      {#if d.locksTaken}<br />Write locks taken{/if}
    </div>
  {:else}
    <span class="badge {cls[d.state]}">{label[d.state]}</span>
  {/if}
  <Handle type="source" position={Position.Right} />
</div>
