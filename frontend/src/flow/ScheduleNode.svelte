<script lang="ts">
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import { formatWhen } from "../lib/jobs.ts";
  import type { ScheduleNodeData } from "../lib/flow/pipeline.ts";

  let { data }: NodeProps = $props();
  const d = $derived(data as unknown as ScheduleNodeData & { onedit?: () => void });
</script>

<div class="card preset-filled-surface-100-900 w-72 space-y-2 border border-surface-300-700 p-3">
  <div class="flex items-center justify-between gap-2">
    <span class="font-semibold">Schedule</span>
    {#if !d.enabled}<span class="badge preset-tonal-surface">paused</span>{/if}
  </div>
  <div class="text-sm">{d.summary}</div>
  {#if d.nextRun}<div class="text-xs opacity-70">Next run {formatWhen(d.nextRun)}</div>{/if}
  {#if d.catchUp}<div class="text-xs opacity-70">Catches up missed runs</div>{/if}
  {#if d.warning}<div class="text-xs text-warning-700-300">{d.warning}</div>{/if}
  {#if d.onedit}<button type="button" class="btn btn-sm preset-tonal-surface nodrag nopan" onclick={d.onedit}>Edit schedule</button>{/if}
  <Handle type="source" position={Position.Bottom} />
</div>
