<script lang="ts">
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import type { PreflightNodeData } from "../lib/flow/run.ts";

  let { data }: NodeProps = $props();
  const d = $derived(data as unknown as PreflightNodeData);
  const label = { waiting_for_lock: "Waiting for lock", checking: "Checking instances", passed: "Checks passed", failed: "Checks failed" };
  const cls = { waiting_for_lock: "preset-tonal-surface", checking: "preset-tonal-primary", passed: "preset-tonal-success", failed: "preset-tonal-error" };
</script>

<div class="card preset-filled-surface-100-900 w-60 space-y-2 border border-surface-300-700 p-3">
  <div class="font-semibold">Preflight</div>
  <span class="badge {cls[d.state]}">{label[d.state]}</span>
  <Handle type="source" position={Position.Right} />
</div>
