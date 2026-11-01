<script lang="ts">
  import type { NodeProps } from "@xyflow/svelte";

  let { data }: NodeProps = $props();
  const d = $derived(data as unknown as { onadd?: () => void });
</script>

<button type="button" class="card w-56 border border-dashed border-surface-400-600 p-3 text-center nodrag nopan hover:preset-tonal-surface" onclick={() => d.onadd?.()}>
  <span class="block text-xl leading-none">+</span>
  <span class="block font-semibold">Add instance</span>
  <span class="block text-xs opacity-70">Alias, API URL and API key</span>
</button>
