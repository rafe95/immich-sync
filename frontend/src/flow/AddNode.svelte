<script lang="ts">
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import type { AddNodeData } from "../lib/flow/pipeline.ts";

  let { data }: NodeProps = $props();
  const d = $derived(data as unknown as AddNodeData & { onadd?: () => void });
</script>

<div class="w-72">
  <Handle type="target" position={Position.Top} />
  <button type="button" class="btn preset-filled-surface-50-950 mx-auto flex h-11 w-44 rounded-xl border-2 border-dashed border-surface-400-600 font-semibold nodrag nopan" disabled={d.disabled} onclick={() => d.onadd?.()}>+ Add step</button>
</div>
