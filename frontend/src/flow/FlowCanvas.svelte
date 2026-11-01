<script lang="ts">
  import { Background, BackgroundVariant, Controls, MiniMap, SvelteFlow, type Edge, type Node, type NodeTypes } from "@xyflow/svelte";
  import InstanceNode from "./InstanceNode.svelte";
  import StepNode from "./StepNode.svelte";
  import LabelEdge from "./LabelEdge.svelte";
  import Refit from "./Refit.svelte";

  let {
    nodes = $bindable(),
    edges = $bindable(),
    nodeTypes = { instance: InstanceNode, step: StepNode } as unknown as NodeTypes,
    minimap = false,
    lockable = false,
    fitKey,
    onnodeclick,
    onedgeclick,
    onnodedragstop,
  }: {
    /** When this value changes the view is fitted again (e.g. the node count). */
    fitKey?: unknown;
    nodes: Node[];
    edges: Edge[];
    nodeTypes?: NodeTypes;
    minimap?: boolean;
    lockable?: boolean;
    onnodeclick?: (node: Node) => void;
    onedgeclick?: (edge: Edge) => void;
    onnodedragstop?: (node: Node) => void;
  } = $props();

  const edgeTypes = { label: LabelEdge } as never;
</script>

<div class="h-full w-full rounded-container border border-surface-300-700">
  <SvelteFlow
    bind:nodes
    bind:edges
    {nodeTypes}
    {edgeTypes}
    fitView
    fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
    nodesConnectable={false}
    nodesDraggable={lockable}
    deleteKey={null}
    proOptions={{ hideAttribution: true }}
    onnodeclick={({ node }) => onnodeclick?.(node)}
    onedgeclick={({ edge }) => onedgeclick?.(edge)}
    onnodedragstop={({ targetNode }) => targetNode && onnodedragstop?.(targetNode)}
  >
    <Background variant={BackgroundVariant.Dots} />
    <Controls showLock={false} />
    {#if minimap}<MiniMap pannable zoomable />{/if}
    {#if fitKey !== undefined}<Refit key={fitKey} />{/if}
  </SvelteFlow>
</div>
