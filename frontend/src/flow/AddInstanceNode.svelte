<script lang="ts">
  import type { NodeProps } from "@xyflow/svelte";

  let { data }: NodeProps = $props();
  const d = $derived(data as unknown as { onadd?: () => void });
</script>

<button type="button" class="card w-64 border-2 border-dashed border-surface-400-600 bg-surface-50-950/60 p-3 text-center nodrag nopan hover:preset-tonal-surface" onclick={() => d.onadd?.()}>
  <span class="block text-xl leading-none">+</span>
  <span class="block font-semibold">Add instance</span>
  <span class="block text-xs opacity-70">Alias, API URL and API key</span>
</button>
