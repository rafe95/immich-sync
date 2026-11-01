<script lang="ts">
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import { formatWhen } from "../lib/jobs.ts";
  import type { ScheduleNodeData } from "../lib/flow/pipeline.ts";

  let { data }: NodeProps = $props();
  const d = $derived(data as unknown as ScheduleNodeData & { onedit?: () => void });
</script>

<div class="card preset-filled-surface-950-50 w-72 space-y-1 p-3">
  <div class="flex items-center gap-2 text-xs font-semibold tracking-wide uppercase opacity-80">
    <span aria-hidden="true">◷</span> Trigger · Schedule
    {#if !d.enabled}<span class="badge preset-tonal-surface ml-auto">paused</span>{/if}
  </div>
  <div class="font-semibold">{d.summary}</div>
  <div class="font-mono text-xs opacity-80">
    {d.cron} · {d.timezone}{d.nextRun ? ` · next ${formatWhen(d.nextRun)}` : ""} · {d.catchUp ? "catches up missed runs" : "no catch-up"}
  </div>
  {#if d.warning}
    <div class="rounded-md bg-warning-100-900 px-2 py-1 text-xs text-warning-800-200">
      {d.warning}.{#if d.onedit} Use Edit schedule to confirm.{/if}
    </div>
  {/if}
  {#if d.onedit}<button type="button" class="btn btn-sm preset-filled-surface-50-950 nodrag nopan" onclick={d.onedit}>Edit schedule</button>{/if}
  <Handle type="source" position={Position.Bottom} />
</div>
