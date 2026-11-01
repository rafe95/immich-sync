<script lang="ts">
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import { opLabel } from "../lib/flow/ops.ts";
  import type { RunStepNodeData } from "../lib/flow/run.ts";

  /** A step of a run: header band with status and duration/percent, source to target, count lines, phase bar. */
  let { data, selected = false }: NodeProps = $props();
  const d = $derived(data as unknown as RunStepNodeData);

  const FRAME: Record<string, string> = {
    running: "border-2 border-primary-500",
    done: "border border-success-500",
    done_with_failures: "border border-warning-500",
    failed: "border border-error-500",
    cancelled: "border border-surface-400-600",
    not_run: "border border-dashed border-surface-400-600",
    waiting: "border border-dashed border-surface-400-600",
    idle: "border border-dashed border-surface-400-600",
  };
  const HEAD: Record<string, string> = {
    running: "preset-tonal-primary",
    done: "preset-tonal-success",
    done_with_failures: "preset-tonal-warning",
    failed: "preset-tonal-error",
    cancelled: "preset-tonal-surface",
    not_run: "",
    waiting: "",
    idle: "",
  };
  const muted = $derived(d.status === "waiting" || d.status === "idle" || d.status === "not_run");
  const circle: Record<string, string> = {
    done: "bg-success-500 text-white",
    done_with_failures: "bg-warning-500 text-white",
    failed: "bg-error-500 text-white",
    cancelled: "bg-surface-500 text-white",
  };
  const glyph: Record<string, string> = { done: "✓", done_with_failures: "!", failed: "✕", cancelled: "–" };
</script>

<div
  class="card preset-filled-surface-50-950 w-72 overflow-hidden {FRAME[d.status]} {selected ? 'ring-2 ring-primary-500' : ''} {muted ? 'opacity-80' : ''}"
  data-status={d.status}
>
  <Handle type="target" position={Position.Left} />
  <div class="flex items-center gap-2 px-3 py-2 {HEAD[d.status]} {muted ? 'border-b border-surface-200-800' : ''}">
    {#if d.status === "running"}
      <span class="inline-block size-5 shrink-0 animate-spin rounded-full border-2 border-primary-200-800 border-t-primary-500" role="img" aria-label="running"></span>
    {:else if circle[d.status]}
      <span class="flex size-5 shrink-0 items-center justify-center rounded-full text-xs {circle[d.status]}" role="img" aria-label={d.status.replaceAll("_", " ")}>{glyph[d.status]}</span>
    {:else}
      <span class="inline-block size-5 shrink-0 rounded-full border-2 border-surface-400-600" role="img" aria-label={d.status === "not_run" ? "not run" : "waiting"}></span>
    {/if}
    <span class="text-sm font-bold {muted ? 'opacity-80' : ''}">{d.position} · {opLabel(d.operation)}</span>
    {#if d.dryRun}<span class="badge preset-tonal-surface text-xs">dry run</span>{/if}
    {#if d.right}<span class="ml-auto text-xs font-semibold">{d.right}</span>{/if}
  </div>
  <div class="space-y-1.5 px-3 py-2 text-sm">
    <div class="font-semibold {muted ? 'opacity-80' : ''}">{d.source} → {d.target}</div>
    {#if d.status === "running"}
      {#if d.phases}
        <div class="grid gap-1" style="grid-template-columns: repeat({d.phases.length}, minmax(0, 1fr))" data-testid="phase-bar">
          {#each d.phases as ph (ph.label)}
            <span class="h-1.5 rounded-full {ph.state === 'done' ? 'bg-success-500' : ph.state === 'active' ? 'bg-primary-500' : 'bg-surface-200-800'}"></span>
          {/each}
        </div>
        <div class="flex flex-wrap gap-x-1 text-xs opacity-80">
          {#each d.phases as ph, i (ph.label)}<span class={ph.state === "active" ? "font-bold" : ""}>{ph.label}{i < d.phases.length - 1 ? " ·" : ""}</span>{/each}
        </div>
      {:else if d.percent !== null}
        <progress class="progress w-full" value={d.percent} max="100"></progress>
      {/if}
    {/if}
    {#each d.lines as line}<div class="opacity-80">{line}</div>{/each}
  </div>
  <Handle type="source" position={Position.Right} />
</div>
