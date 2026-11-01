<script lang="ts">
  import type { Edge, Node, NodeTypes } from "@xyflow/svelte";
  import FlowCanvas from "./FlowCanvas.svelte";
  import InstanceNode from "./InstanceNode.svelte";
  import PreflightNode from "./PreflightNode.svelte";
  import StepNode from "./StepNode.svelte";
  import { buildRunGraph } from "../lib/flow/run.ts";
  import { formatBytes, stepSummaries, type ConsoleState, type Run } from "../lib/runs.ts";

  /** The run as a row of step boxes. Clicking a step selects it (the parent filters the console to it). */
  let { run, progress, selected = $bindable(null) }: { run: Run; progress: ConsoleState; selected: number | null } = $props();

  const nodeTypes = { instance: InstanceNode, step: StepNode, preflight: PreflightNode } as unknown as NodeTypes;
  let nodes = $state.raw<Node[]>([]);
  let edges = $state.raw<Edge[]>([]);

  $effect(() => {
    const g = buildRunGraph(run, progress);
    nodes = g.nodes.map((n) => ({ ...n, selected: selected !== null && n.id === `step-${selected}` }));
    edges = g.edges;
  });

  function pick(n: Node) {
    if (!n.id.startsWith("step-")) return;
    const pos = Number(n.id.slice(5));
    selected = selected === pos ? null : pos;
  }

  const block = $derived(selected === null ? null : (stepSummaries(progress.summaries, progress.failures).find((b) => b.step === selected) ?? null));
  const liveFailures = $derived(selected === null ? [] : progress.failures.filter((f) => f.step === selected));
</script>

<div class="space-y-3">
  <div class="h-64">
    <FlowCanvas bind:nodes bind:edges {nodeTypes} onnodeclick={pick} />
  </div>
  {#if selected !== null}
    <div class="card preset-outlined-surface-200-800 space-y-1 p-3 text-sm">
      <div class="flex items-center justify-between gap-2">
        <strong>Step {selected}</strong>
        <button type="button" class="btn btn-sm preset-tonal-surface" onclick={() => (selected = null)}>Show all steps</button>
      </div>
      {#if block?.totals}
        {@const t = block.totals}
        <p>
          Found {t.found} · {t.done} {t.dryRun ? "would be " : ""}{t.doneLabel} · {t.skipped} skipped · {t.failed} failed
          {#if t.inTargetTrash} · {t.inTargetTrash} in target trash (never re-uploaded){/if}
          · {formatBytes(t.bytes)}
        </p>
      {:else}
        <p class="opacity-70">No counts reported for this step yet.</p>
      {/if}
      {#if liveFailures.length}
        <ul class="list-disc pl-5">
          {#each liveFailures as f (f.eventId)}<li>{f.name}{f.message ? `: ${f.message}` : ""}</li>{/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
