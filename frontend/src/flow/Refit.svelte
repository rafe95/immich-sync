<script lang="ts">
  import { useSvelteFlow } from "@xyflow/svelte";

  // Re-fits the view whenever `key` changes (e.g. nodes were added or removed). Must render inside <SvelteFlow>.
  let { key }: { key: unknown } = $props();
  const { fitView } = useSvelteFlow();
  let first = true;

  $effect(() => {
    void key;
    // SvelteFlow's own `fitView` prop handles the initial fit.
    if (first) {
      first = false;
      return;
    }
    // Wait a beat so new nodes are measured before fitting.
    const t = setTimeout(() => void fitView({ maxZoom: 1, padding: 0.2, duration: 200 }), 60);
    return () => clearTimeout(t);
  });
</script>
