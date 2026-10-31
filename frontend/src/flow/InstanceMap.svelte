<script lang="ts">
  import type { Edge, Node } from "@xyflow/svelte";
  import FlowCanvas from "./FlowCanvas.svelte";
  import MapJobPanel from "./MapJobPanel.svelte";
  import { autoLayout, buildMap, loadLayout, mergeLayout, saveLayout, type Layout, type MapInput } from "../lib/flow/map.ts";

  let { map, onopenrun, onchanged }: { map: MapInput; onopenrun?: (runId: string) => void; onchanged: () => void } = $props();

  let saved = $state<Layout | null>(loadLayout());
  let selectedJobId = $state<string | null>(null);
  let nodes = $state.raw<Node[]>([]);
  let edges = $state.raw<Edge[]>([]);
  // Positions moved by dragging since the last reload, so a data refresh does not snap nodes back.
  let moved = $state<Layout>({});

  $effect(() => {
    const built = buildMap(map);
    const auto = autoLayout(built.nodes, built.edges);
    const pos = mergeLayout(auto, { ...(saved ?? {}), ...moved });
    nodes = built.nodes.map((n) => ({ ...n, position: pos[n.id] ?? n.position }));
    edges = built.edges.map((e) => ({ ...e, selected: selectedJobId !== null && (e.data as { jobId?: string } | undefined)?.jobId === selectedJobId }));
  });

  const job = $derived(map.jobs.find((j) => j.id === selectedJobId) ?? null);

  function dragStop(n: Node) {
    moved = { ...moved, [n.id]: { x: n.position.x, y: n.position.y } };
    saveLayout({ ...(saved ?? {}), ...moved });
  }
  function resetLayout() {
    saveLayout(null);
    saved = null;
    moved = {};
  }
</script>

<div class="space-y-3">
  <div class="flex items-center justify-between gap-2">
    <p class="text-sm opacity-70">Instances and the jobs that move data between them. Drag instances to arrange them; click a job's line for details.</p>
    <button type="button" class="btn btn-sm preset-tonal-surface" onclick={resetLayout}>Reset layout</button>
  </div>
  <div class="grid gap-3 lg:grid-cols-[1fr_18rem]">
    <div class="h-96">
      <FlowCanvas
        bind:nodes
        bind:edges
        lockable
        onedgeclick={(e) => (selectedJobId = (e.data as { jobId?: string } | undefined)?.jobId ?? null)}
        onnodedragstop={dragStop}
      />
    </div>
    {#if job}
      <MapJobPanel {job} {map} {onopenrun} {onchanged} onclose={() => (selectedJobId = null)} />
    {/if}
  </div>
</div>
