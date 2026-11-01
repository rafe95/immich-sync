<script lang="ts">
  import type { Operation } from "./lib/runs.ts";

  let { value = $bindable() }: { value: Operation } = $props();

  const OPTIONS: Array<[Operation, string]> = [
    ["copy", "Copy"],
    ["move", "Move"],
    ["sync_metadata", "Sync metadata"],
  ];
</script>

<!-- A segmented control made of real radio inputs, so keyboard and screen-reader behaviour is the native one. -->
<fieldset class="space-y-2">
  <legend class="label-text mb-1">Operation</legend>
  <div class="bg-surface-100-900 rounded-container inline-flex flex-wrap gap-0.5 p-1">
    {#each OPTIONS as [option, label] (option)}
      <label class="has-checked:bg-surface-50-950 has-checked:font-semibold has-checked:shadow-sm has-focus-visible:ring-primary-500 cursor-pointer rounded-base px-3.5 py-1.5 text-sm has-focus-visible:ring-2">
        <input class="sr-only" type="radio" name="operation" value={option} bind:group={value} />{label}
      </label>
    {/each}
  </div>
  {#if value === "move"}
    <div role="note" class="preset-tonal-warning rounded-container p-3 text-sm">
      <p class="font-bold">Move with verify-before-trash</p>
      <p>Move copies each asset, verifies it on the target, and only then sends the source asset to the source's trash. Nothing is permanently deleted.</p>
    </div>
  {/if}
</fieldset>
