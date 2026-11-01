<script lang="ts">
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import type { AddNodeData } from "../lib/flow/pipeline.ts";

  let { data }: NodeProps = $props();
  const d = $derived(data as unknown as AddNodeData & { onadd?: () => void });
</script>

<div class="w-72">
  <Handle type="target" position={Position.Top} />
  <button type="button" class="btn preset-tonal-primary w-full border border-dashed nodrag nopan" disabled={d.disabled} onclick={() => d.onadd?.()}>+ Add step</button>
</div>
