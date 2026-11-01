<script lang="ts">
  import type { Instance } from "./lib/api.ts";
  import { api } from "./lib/session.svelte.ts";
  import { checkSummary } from "./lib/instances.ts";

  // The list view of the same instances the map draws. Editing and deleting happen in the shared side panel (onmanage).
  let { instances, onmanage, onchanged }: { instances: Instance[]; onmanage: (i: Instance) => void; onchanged: () => void } = $props();

  const toneCls = { surface: "preset-tonal-surface", success: "preset-tonal-success", warning: "preset-tonal-warning", error: "preset-tonal-error" };
  let busyId = $state<string | null>(null);
  let error = $state<string | null>(null);

  async function act(i: Instance, fn: () => Promise<unknown>) {
    busyId = i.id;
    error = null;
    try {
      await fn();
      onchanged();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busyId = null;
    }
  }
</script>

{#if error}<p class="mb-2 text-sm text-error-500" role="alert">{error}</p>{/if}
<ul class="space-y-3">
  {#each instances as i (i.id)}
    {@const s = checkSummary(i.lastCheck)}
    <li class="card preset-outlined-surface-200-800 flex flex-wrap items-center justify-between gap-2 p-4">
      <div class="min-w-0">
        <h3 class="h6 flex flex-wrap items-center gap-2">
          <span class="break-all">{i.alias}</span>
          {#if i.isDefault}<span class="badge preset-filled-primary-500">Default</span>{/if}
          <span class="badge {toneCls[s.tone]}">{s.label}</span>
        </h3>
        <p class="text-sm break-all opacity-70">{i.apiUrl}</p>
        {#if i.note}<p class="text-sm">{i.note}</p>{/if}
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-sm preset-tonal-primary" type="button" disabled={busyId === i.id} onclick={() => act(i, () => api.checkInstance(i.id))}>
          {busyId === i.id ? "Working…" : "Test connection"}
        </button>
        {#if !i.isDefault}
          <button class="btn btn-sm preset-tonal-surface" type="button" disabled={busyId === i.id} onclick={() => act(i, () => api.updateInstance(i.id, { isDefault: true }))}>Set default</button>
        {/if}
        <button class="btn btn-sm preset-tonal-surface" type="button" onclick={() => onmanage(i)}>Manage</button>
      </div>
    </li>
  {/each}
</ul>
