<script lang="ts">
  import type { Edge, Node, NodeTypes } from "@xyflow/svelte";
  import FlowCanvas from "./FlowCanvas.svelte";
  import InstanceNode from "./InstanceNode.svelte";
  import StepNode from "./StepNode.svelte";
  import ScheduleNode from "./ScheduleNode.svelte";
  import AddNode from "./AddNode.svelte";
  import type { Instance } from "../lib/api.ts";
  import { MAX_STEPS, OP_LABEL, type ScheduleRecord, type StepForm } from "../lib/jobs.ts";
  import type { Operation } from "../lib/runs.ts";
  import { opTone } from "../lib/flow/ops.ts";
  import { buildPipeline, STEP_GAP } from "../lib/flow/pipeline.ts";

  let {
    steps,
    schedule,
    instances,
    selectedKey,
    onselect,
    onadd,
    onreorder,
    oneditschedule,
  }: {
    steps: StepForm[];
    schedule: ScheduleRecord | null;
    instances: Instance[];
    selectedKey: string | null;
    onselect: (key: string | null) => void;
    onadd: (operation: Operation, index: number) => void;
    onreorder: (key: string, y: number) => void;
    oneditschedule?: () => void;
  } = $props();

  const nodeTypes = { instance: InstanceNode, step: StepNode, schedule: ScheduleNode, add: AddNode } as unknown as NodeTypes;
  const atMax = $derived(steps.length >= MAX_STEPS);
  const firstStepY = $derived(schedule ? STEP_GAP : 0);
  const OPS = Object.keys(OP_LABEL) as Operation[];
  const toneCls = { primary: "preset-tonal-primary", warning: "preset-tonal-warning", tertiary: "preset-tonal-tertiary" };

  let nodes = $state.raw<Node[]>([]);
  let edges = $state.raw<Edge[]>([]);
  let box: HTMLDivElement | undefined = $state();

  $effect(() => {
    const built = buildPipeline({ steps, schedule, instances, selectedKey });
    nodes = built.nodes.map((n) => {
      if (n.id === "schedule") return { ...n, data: { ...n.data, onedit: oneditschedule } };
      if (n.id === "add") return { ...n, data: { ...n.data, disabled: atMax, onadd: () => onadd("copy", steps.length) } };
      return { ...n, draggable: true };
    });
    edges = built.edges;
  });

  /** Insertion slot for a drop at a screen y: the number of step nodes whose centre lies above it. */
  function slotAt(clientY: number): number {
    if (!box) return steps.length;
    let slot = 0;
    for (const s of steps) {
      const el = box.querySelector<HTMLElement>(`.svelte-flow__node[data-id="${s.key}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.top + r.height / 2 < clientY) slot++;
    }
    return slot;
  }

  function dragStop(n: Node) {
    if (n.type !== "step") return;
    onreorder(n.id, n.position.y - firstStepY);
  }

  function drop(e: DragEvent) {
    e.preventDefault();
    const op = e.dataTransfer?.getData("application/x-immich-op") as Operation | undefined;
    if (!op || !(op in OP_LABEL) || atMax) return;
    onadd(op, slotAt(e.clientY));
  }
</script>

<div class="grid gap-3 md:grid-cols-[10rem_1fr]">
  <div class="space-y-2" aria-label="Step palette">
    <p class="label-text">Add a step</p>
    {#each OPS as op (op)}
      <button
        type="button"
        class="btn w-full {toneCls[opTone(op)]}"
        draggable="true"
        disabled={atMax}
        ondragstart={(e) => e.dataTransfer?.setData("application/x-immich-op", op)}
        onclick={() => onadd(op, steps.length)}
      >{OP_LABEL[op]}</button>
    {/each}
    <p class="text-xs opacity-70">Click to append, or drag onto the pipeline.</p>
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="h-[32rem]" bind:this={box} ondragover={(e) => e.preventDefault()} ondrop={drop}>
    <FlowCanvas
      bind:nodes
      bind:edges
      {nodeTypes}
      lockable
      onnodeclick={(n) => onselect(n.type === "step" ? n.id : null)}
      onnodedragstop={dragStop}
    />
  </div>
</div>
