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
    bordered = true,
    lockable = false,
    fitMaxZoom = 1,
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
    /** Draw the canvas border; off when a surrounding card already has one. */
    bordered?: boolean;
    lockable?: boolean;
    /** Largest zoom the initial fit may use; the map raises it so a few nodes read larger. */
    fitMaxZoom?: number;
    onnodeclick?: (node: Node) => void;
    onedgeclick?: (edge: Edge) => void;
    onnodedragstop?: (node: Node) => void;
  } = $props();

  const edgeTypes = { label: LabelEdge } as never;
</script>

<div class="h-full w-full {bordered ? 'rounded-container border border-surface-300-700' : ''}">
  <SvelteFlow
    bind:nodes
    bind:edges
    {nodeTypes}
    {edgeTypes}
    fitView
    fitViewOptions={{ maxZoom: fitMaxZoom, padding: 0.12 }}
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
    {#if minimap}<MiniMap pannable zoomable nodeColor="var(--color-primary-300-700)" style="width: 150px; height: 100px;" />{/if}
    {#if fitKey !== undefined}<Refit key={fitKey} />{/if}
  </SvelteFlow>
</div>
