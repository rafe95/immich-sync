<script lang="ts">
  import { Switch } from "@skeletonlabs/skeleton-svelte";
  import type { Snippet } from "svelte";

  /**
   * On/off toggle built on the Skeleton Switch. `checked` is bindable; `onchange` is called with the new value.
   * `label` (text) or `children` (richer label content) name the switch; `hint` is secondary text inside the label.
   */
  let {
    checked = $bindable(false),
    disabled = false,
    label,
    hint,
    name,
    required,
    onchange,
    children,
  }: {
    checked?: boolean;
    disabled?: boolean;
    label?: string;
    hint?: string;
    name?: string;
    required?: boolean;
    onchange?: (checked: boolean) => void;
    children?: Snippet;
  } = $props();
</script>

<Switch class="w-full" {checked} {disabled} {name} {required} onCheckedChange={(e) => { checked = e.checked; onchange?.(e.checked); }}>
  <Switch.Control><Switch.Thumb /></Switch.Control>
  <Switch.Label>
    {#if children}{@render children()}{:else}{label}{/if}{#if hint}<span class="block text-sm opacity-70">{hint}</span>{/if}
  </Switch.Label>
  <Switch.HiddenInput />
</Switch>
