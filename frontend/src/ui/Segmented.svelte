<script lang="ts" generics="T extends string">
  import { SegmentedControl } from "@skeletonlabs/skeleton-svelte";

  /** One shared Skeleton SegmentedControl (a radio group): arrow keys, group name and hidden form inputs come from it. */
  let {
    options,
    value,
    onchange,
    ariaLabel,
    name,
    disabled = false,
    compact = false,
  }: {
    options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
    value: T;
    onchange: (value: T) => void;
    ariaLabel: string;
    name?: string;
    disabled?: boolean;
    /** Smaller items, for toolbars and the header. */
    compact?: boolean;
  } = $props();
</script>

<SegmentedControl class="w-fit" {value} {name} {disabled} aria-label={ariaLabel} onValueChange={(e) => e.value && e.value !== value && onchange(e.value as T)}>
  <SegmentedControl.Control>
    <SegmentedControl.Indicator />
    {#each options as o (o.value)}
      <SegmentedControl.Item class={compact ? "px-3! py-1! text-sm" : ""} value={o.value} disabled={o.disabled}>
        <SegmentedControl.ItemText>{o.label}</SegmentedControl.ItemText>
        <SegmentedControl.ItemHiddenInput />
      </SegmentedControl.Item>
    {/each}
  </SegmentedControl.Control>
</SegmentedControl>
