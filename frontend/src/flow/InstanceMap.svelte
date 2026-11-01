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
  import { MarkerType } from "@xyflow/svelte";
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
  let selectedStep = $state(1);
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
      const position = Number(e.id.split(":").pop()) || 1;
      const color = { primary: "var(--color-primary-500)", warning: "var(--color-warning-500)", tertiary: "var(--color-tertiary-500)", neutral: "var(--color-surface-500)" }[e.data?.style === "warning" ? "warning" : (e.data?.tone ?? "neutral")];
      // zIndex lifts the line and its label above the instance cards, which sit close together on a small map.
      return {
        ...e,
        zIndex: 1000,
        markerEnd: { type: MarkerType.ArrowClosed, color },
        data: { ...e.data!, onselect: jobId ? () => selectJob(jobId, position) : undefined },
        selected: selectedJobId !== null && jobId === selectedJobId,
      };
    });
  });

  const job = $derived(map.jobs.find((j) => j.id === selectedJobId) ?? null);
  const instance = $derived(map.instances.find((i) => i.id === selectedInstanceId) ?? null);

  function selectJob(id: string | null, position = 1) {
    selectedJobId = id;
    selectedStep = position;
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

</script>

<div class="space-y-3">
  <div class="flex flex-wrap items-center gap-2">
    <h2 class="mr-1 text-base font-semibold">Instances</h2>
    <button type="button" class="btn btn-sm preset-filled-primary-500" onclick={startAdd}>+ Add instance</button>
    <button type="button" class="btn btn-sm preset-tonal-surface" disabled={checkingAll || map.instances.length === 0} onclick={checkAll}>{checkingAll ? "Checking…" : "Check all"}</button>
    <div class="inline-flex gap-1 rounded-container bg-surface-100-900 p-1" role="group" aria-label="View">
      <button type="button" class="btn btn-sm {mode === 'map' ? 'preset-filled-surface-500' : ''}" aria-pressed={mode === "map"} onclick={() => (mode = "map")}>Map</button>
      <button type="button" class="btn btn-sm {mode === 'list' ? 'preset-filled-surface-500' : ''}" aria-pressed={mode === "list"} onclick={() => (mode = "list")}>List</button>
    </div>
    {#if notice}<p class="text-sm" role="status">{notice}</p>{/if}
  </div>

  {#if map.instances.length === 0 && !adding}
    <p class="text-sm opacity-70">No instances registered yet. Add one to get started.</p>
  {:else}
    <div class="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section class="flex min-h-[42rem] flex-col overflow-hidden rounded-container border border-surface-200-800 bg-surface-50-950" aria-label="Instance map">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-surface-200-800 px-4 py-3">
          <div class="flex flex-wrap items-baseline gap-x-3">
            <h3 class="text-base font-semibold">Instance map</h3>
            <span class="text-xs opacity-70">Nodes are Immich instances, edges are job steps</span>
          </div>
          <ul class="flex flex-wrap items-center gap-4 text-xs" aria-label="Line colours">
            <li class="flex items-center gap-1.5"><span class="inline-block h-[3px] w-[18px] rounded bg-primary-500"></span>Copy</li>
            <li class="flex items-center gap-1.5"><span class="inline-block h-[3px] w-[18px] rounded bg-warning-500"></span>Move</li>
            <li class="flex items-center gap-1.5"><span class="inline-block h-[3px] w-[18px] rounded bg-tertiary-500"></span>Sync metadata</li>
            <li class="flex items-center gap-1.5"><span class="inline-block w-[18px] border-t-[3px] border-dashed border-surface-700-300"></span>Running</li>
          </ul>
        </div>
        {#if mode === "map"}
          <div class="relative min-h-0 flex-1">
            <div class="absolute inset-0">
            <FlowCanvas
              bind:nodes
              bind:edges
              lockable
              bordered={false}
              fitMaxZoom={1.4}
              {nodeTypes}
              onnodeclick={(n) => n.type === "instance" && !n.id.startsWith("unknown:") && selectInstance(n.id)}
              onedgeclick={(e) => selectJob((e.data as { jobId?: string } | undefined)?.jobId ?? null, Number(e.id.split(":").pop()) || 1)}
              onnodedragstop={dragStop}
            />
            </div>
          </div>
          <p class="flex flex-wrap items-center justify-between gap-2 border-t border-surface-200-800 px-4 py-2 text-xs opacity-70">
            <span>Drag instances to arrange them; click an instance to manage it, or a line for details.</span>
            {#if map.instances.length > 0}<button type="button" class="anchor" onclick={resetLayout}>Reset layout</button>{/if}
          </p>
        {:else}
          <div class="p-4"><InstanceList instances={map.instances} onmanage={(i) => selectInstance(i.id)} {onchanged} /></div>
        {/if}
      </section>
      {#if adding}
        <MapInstancePanel instance={null} {map} {onchanged} {onsaved} {ondeleted} onclose={closePanels} />
      {:else if instance}
        <MapInstancePanel {instance} {map} {onchanged} {onsaved} {ondeleted} onclose={closePanels} />
      {:else if job}
        <MapJobPanel {job} step={selectedStep} {map} {onopenrun} {onopenjob} eventsFor={(id) => live.get(id)} {onchanged} onclose={closePanels} />
      {:else}
        <aside class="card preset-outlined-surface-200-800 p-4 text-sm opacity-80" aria-label="Details">
          Select an instance to manage it, or a job's line to see its progress.
        </aside>
      {/if}
    </div>
  {/if}
</div>
