<script lang="ts">
  import { OP_LABEL } from "../lib/jobs.ts";
  import type { Operation } from "../lib/runs.ts";
  import { opTone } from "../lib/flow/ops.ts";

  // Click appends a step; dragging one onto the pipeline canvas inserts it where it is dropped (see JobPipeline).
  let { disabled = false, onadd }: { disabled?: boolean; onadd: (operation: Operation) => void } = $props();

  const OPS = Object.keys(OP_LABEL) as Operation[];
  const toneCls = { primary: "preset-tonal-primary", warning: "preset-tonal-warning", tertiary: "preset-tonal-tertiary" };
  const borderCls = { primary: "border-primary-300-700", warning: "border-warning-300-700", tertiary: "border-tertiary-300-700" };
</script>

<section class="card preset-outlined-surface-200-800 space-y-2 p-3" aria-label="Step palette">
  <h3 class="text-xs font-semibold tracking-wide uppercase opacity-70">Add a step</h3>
  {#each OPS as op (op)}
    <button
      type="button"
      class="btn w-full justify-start rounded-lg border font-semibold {toneCls[opTone(op)]} {borderCls[opTone(op)]}"
      draggable="true"
      {disabled}
      ondragstart={(e) => e.dataTransfer?.setData("application/x-immich-op", op)}
      onclick={() => onadd(op)}
    >{OP_LABEL[op]}</button>
  {/each}
  <p class="text-xs opacity-70">Click to append, or drag onto the pipeline; drop between two steps to insert.</p>
</section>
