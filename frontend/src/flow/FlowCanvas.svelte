<script lang="ts">
  import { Background, BackgroundVariant, Controls, MiniMap, SvelteFlow, type Edge, type Node, type NodeTypes } from "@xyflow/svelte";
  import InstanceNode from "./InstanceNode.svelte";
  import StepNode from "./StepNode.svelte";
  import LabelEdge from "./LabelEdge.svelte";

  let {
    nodes = $bindable(),
    edges = $bindable(),
    nodeTypes = { instance: InstanceNode, step: StepNode } as unknown as NodeTypes,
    minimap = false,
    lockable = false,
    onnodeclick,
    onedgeclick,
    onnodedragstop,
  }: {
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

<div class="h-full min-h-80 w-full rounded-container border border-surface-300-700">
  <SvelteFlow
    bind:nodes
    bind:edges
    {nodeTypes}
    {edgeTypes}
    fitView
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
  </SvelteFlow>
</div>
