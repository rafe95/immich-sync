<script lang="ts">
  import type { Edge, Node, NodeTypes } from "@xyflow/svelte";
  import FlowCanvas from "./FlowCanvas.svelte";
  import InstanceNode from "./InstanceNode.svelte";
  import PreflightNode from "./PreflightNode.svelte";
  import StepNode from "./StepNode.svelte";
  import { buildRunGraph } from "../lib/flow/run.ts";
  import type { ConsoleState, Run } from "../lib/runs.ts";

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
</script>

<div class="h-64">
  <FlowCanvas bind:nodes bind:edges {nodeTypes} onnodeclick={pick} />
</div>
