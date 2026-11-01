<script lang="ts">
  import Segmented from "./ui/Segmented.svelte";
  import type { Operation } from "./lib/runs.ts";

  let { value = $bindable() }: { value: Operation } = $props();

  const OPTIONS: Array<{ value: Operation; label: string }> = [
    { value: "copy", label: "Copy" },
    { value: "move", label: "Move" },
    { value: "sync_metadata", label: "Sync metadata" },
  ];
</script>

<fieldset class="space-y-2">
  <legend class="label-text mb-1">Operation</legend>
  <Segmented options={OPTIONS} {value} name="operation" ariaLabel="Operation" onchange={(v) => (value = v)} />
  {#if value === "move"}
    <div role="note" class="preset-tonal-warning rounded-container p-3 text-sm">
      <p class="font-bold">Move with verify-before-trash</p>
      <p>Move copies each asset, verifies it on the target, and only then sends the source asset to the source's trash. Nothing is permanently deleted.</p>
    </div>
  {/if}
</fieldset>
