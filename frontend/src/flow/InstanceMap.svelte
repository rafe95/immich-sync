<script lang="ts">
  import { untrack } from "svelte";
  import type { Edge, Node, NodeTypes } from "@xyflow/svelte";
  import { api } from "../lib/session.svelte.ts";
  import type { Instance } from "../lib/api.ts";
  import AddInstanceNode from "./AddInstanceNode.svelte";
  import FlowCanvas from "./FlowCanvas.svelte";
  import InstanceNode from "./InstanceNode.svelte";
  import MapInstancePanel from "./MapInstancePanel.svelte";
  import MapJobPanel from "./MapJobPanel.svelte";
  import InstanceList from "../InstanceList.svelte";
  import { addInstanceNode, autoLayout, buildMap, loadLayout, mergeLayout, placeholderPosition, saveLayout, type Layout, type MapInput } from "../lib/flow/map.ts";
  import { livePercents, withLivePercents, type LivePercent } from "../lib/flow/live.ts";
  import { createLiveRuns } from "../lib/flow/liveRuns.svelte.ts";

  let { map, onopenrun, onopenjob, onchanged }: { map: MapInput; onopenrun?: (runId: string) => void; onopenjob?: (jobId: string) => void; onchanged: () => void } = $props();

  // A live event stream per running run feeds the percentages on the lines and the job panel.
  const live = createLiveRuns(api);
  $effect(() => {
    const ids = map.active.filter((a) => !a.queued).map((a) => a.run.id);
    untrack(() => live.sync(ids));
  });
  $effect(() => () => live.stopAll());
  // A string, so the map is only rebuilt when a percentage actually changes, not on every log line.
  const percentsKey = $derived(JSON.stringify(livePercents(map.active, (id) => live.get(id)?.state)));

  const nodeTypes = { instance: InstanceNode, add: AddInstanceNode } as unknown as NodeTypes;
  let saved = $state<Layout | null>(loadLayout());
  let mode = $state<"map" | "list">("map");
  // At most one panel is open: a job (edge), an instance (node or list row), or the add form.
  let selectedJobId = $state<string | null>(null);
  let selectedInstanceId = $state<string | null>(null);
  let adding = $state(false);
  let checkingAll = $state(false);
  let notice = $state<string | null>(null);
  let nodes = $state.raw<Node[]>([]);
  let edges = $state.raw<Edge[]>([]);
  // Positions moved by dragging since the last reload, so a data refresh does not snap nodes back.
  let moved = $state<Layout>({});

  $effect(() => {
    const built = buildMap(withLivePercents(map, JSON.parse(percentsKey) as Record<string, LivePercent>));
    const auto = autoLayout(built.nodes, built.edges);
    const pos = mergeLayout(auto, { ...(saved ?? {}), ...moved });
    const placed: Node[] = built.nodes.map((n) => ({ ...n, position: pos[n.id] ?? n.position, data: { ...n.data, selected: n.id === selectedInstanceId } }));
    nodes = [...placed, { ...addInstanceNode(), position: placeholderPosition(placed.map((n) => n.position)), data: { onadd: startAdd } }];
    edges = built.edges.map((e) => {
      const jobId = e.data?.jobId;
      // zIndex lifts the line and its label above the instance cards, which sit close together on a small map.
      return { ...e, zIndex: 1000, data: { ...e.data!, onselect: jobId ? () => selectJob(jobId) : undefined }, selected: selectedJobId !== null && jobId === selectedJobId };
    });
  });

  const job = $derived(map.jobs.find((j) => j.id === selectedJobId) ?? null);
  const instance = $derived(map.instances.find((i) => i.id === selectedInstanceId) ?? null);

  function selectJob(id: string | null) {
    selectedJobId = id;
    selectedInstanceId = null;
    adding = false;
  }
  function selectInstance(id: string) {
    selectedInstanceId = id;
    selectedJobId = null;
    adding = false;
  }
  function startAdd() {
    adding = true;
    selectedInstanceId = null;
    selectedJobId = null;
  }
  function closePanels() {
    adding = false;
    selectedInstanceId = null;
    selectedJobId = null;
  }
  function dragStop(n: Node) {
    moved = { ...moved, [n.id]: { x: n.position.x, y: n.position.y } };
    saveLayout({ ...(saved ?? {}), ...moved });
  }
  function resetLayout() {
    saveLayout(null);
    saved = null;
    moved = {};
  }

  function onsaved(i: Instance) {
    adding = false;
    selectedInstanceId = i.id;
    notice = `Saved ${i.alias}.`;
    onchanged();
  }
  function ondeleted(id: string) {
    if (selectedInstanceId === id) selectedInstanceId = null;
    notice = "Instance deleted.";
    onchanged();
  }

  async function checkAll() {
    checkingAll = true;
    notice = null;
    const failed: string[] = [];
    for (const i of map.instances) {
      try {
        await api.checkInstance(i.id);
      } catch {
        failed.push(i.alias);
      }
    }
    checkingAll = false;
    notice = failed.length ? `Could not run the connection test for: ${failed.join(", ")}.` : "All connection tests finished.";
    onchanged();
  }

  const panelOpen = $derived(adding || instance !== null || job !== null);
</script>

<div class="space-y-3">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <button type="button" class="btn btn-sm preset-filled-primary-500" onclick={startAdd}>+ Add instance</button>
      <button type="button" class="btn btn-sm preset-tonal-surface" disabled={checkingAll || map.instances.length === 0} onclick={checkAll}>{checkingAll ? "Checking…" : "Check all"}</button>
      <div class="inline-flex gap-1 rounded-container bg-surface-100-900 p-1" role="group" aria-label="View">
        <button type="button" class="btn btn-sm {mode === 'map' ? 'preset-filled-surface-500' : ''}" aria-pressed={mode === "map"} onclick={() => (mode = "map")}>Map</button>
        <button type="button" class="btn btn-sm {mode === 'list' ? 'preset-filled-surface-500' : ''}" aria-pressed={mode === "list"} onclick={() => (mode = "list")}>List</button>
      </div>
    </div>
    {#if mode === "map" && map.instances.length > 0}
      <button type="button" class="btn btn-sm preset-tonal-surface" onclick={resetLayout}>Reset layout</button>
    {/if}
  </div>
  {#if notice}
    <p class="text-sm" role="status">{notice}</p>
  {/if}

  {#if map.instances.length === 0 && !adding}
    <p class="text-sm opacity-70">No instances registered yet. Add one to get started.</p>
  {:else}
    <div class="grid gap-3 {panelOpen ? 'lg:grid-cols-[1fr_22rem]' : ''}">
      {#if mode === "map"}
        <div class="h-96">
          <FlowCanvas
            bind:nodes
            bind:edges
            lockable
            {nodeTypes}
            onnodeclick={(n) => n.type === "instance" && !n.id.startsWith("unknown:") && selectInstance(n.id)}
            onedgeclick={(e) => selectJob((e.data as { jobId?: string } | undefined)?.jobId ?? null)}
            onnodedragstop={dragStop}
          />
        </div>
      {:else}
        <InstanceList instances={map.instances} onmanage={(i) => selectInstance(i.id)} {onchanged} />
      {/if}
      {#if adding}
        <MapInstancePanel instance={null} {map} {onchanged} {onsaved} {ondeleted} onclose={closePanels} />
      {:else if instance}
        <MapInstancePanel {instance} {map} {onchanged} {onsaved} {ondeleted} onclose={closePanels} />
      {:else if job}
        <MapJobPanel {job} {map} {onopenrun} {onopenjob} eventsFor={(id) => live.get(id)} {onchanged} onclose={closePanels} />
      {/if}
    </div>
    {#if mode === "map"}
      <p class="text-sm opacity-70">Drag instances to arrange them. Click an instance to manage it, or a job's line for details.</p>
    {/if}
  {/if}
</div>
