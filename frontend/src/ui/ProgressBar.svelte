<script lang="ts">
  import { Progress } from "@skeletonlabs/skeleton-svelte";

  /**
   * Linear progress bar on Skeleton's Progress. Give `value` (+ `max`, default 100) or `percent`;
   * a null value renders the indeterminate animation.
   */
  let {
    value = undefined,
    max = 100,
    percent = undefined,
    label,
    class: cls = "",
  }: { value?: number | null; max?: number | null; percent?: number | null; label: string; class?: string } = $props();

  const resolved = $derived.by(() => {
    if (percent !== undefined) return { value: percent, max: 100 };
    const m = max && max > 0 ? max : null;
    return value === undefined || value === null || m === null ? { value: null, max: 100 } : { value: Math.min(value, m), max: m };
  });
</script>

<Progress value={resolved.value} max={resolved.max} min={0} class="w-full {cls}">
  <Progress.Track class="h-2" aria-label={label}>
    <Progress.Range />
  </Progress.Track>
</Progress>
