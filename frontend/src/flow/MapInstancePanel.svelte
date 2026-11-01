<script lang="ts">
  import type { Instance } from "../lib/api.ts";
  import { api } from "../lib/session.svelte.ts";
  import { jobsUsing } from "../lib/instances.ts";
  import type { MapInput } from "../lib/flow/map.ts";
  import InstanceCheckView from "../InstanceCheckView.svelte";
  import InstanceForm from "../InstanceForm.svelte";

  // `instance` null = adding a new one. Data changes only through the form and buttons in this panel.
  let {
    instance,
    map,
    onchanged,
    onsaved,
    ondeleted,
    onclose,
  }: { instance: Instance | null; map: MapInput; onchanged: () => void; onsaved: (i: Instance) => void; ondeleted: (id: string) => void; onclose: () => void } = $props();

  const uses = $derived(instance ? jobsUsing(instance.id, map.jobs) : []);
  let checking = $state(false);
  let error = $state<string | null>(null);

  async function checkNow() {
    if (!instance) return;
    checking = true;
    error = null;
    try {
      await api.checkInstance(instance.id);
      onchanged();
    } catch (e) {
      error = `Connection test failed to run: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      checking = false;
    }
  }
</script>

<aside class="card preset-outlined-surface-200-800 bg-surface-50-950 space-y-4 p-4" aria-label={instance ? `Instance ${instance.alias}` : "Add instance"}>
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <div class="text-[11px] font-semibold tracking-wide uppercase opacity-60">{instance ? "Selected instance" : "New instance"}</div>
      <h3 class="h5 break-all">{instance ? instance.alias : "Add instance"}</h3>
      {#if instance}<div class="text-xs opacity-70">{uses.length === 0 ? "Not used by any job" : `Used by ${uses.length} ${uses.length === 1 ? "job" : "jobs"}`}</div>{/if}
    </div>
    <button type="button" class="btn btn-sm preset-tonal-surface" aria-label="Close panel" onclick={onclose}>×</button>
  </div>

  {#if instance}
    <section class="space-y-1 border-t border-surface-200-800 pt-3 text-sm" aria-label="Jobs using this instance">
      {#if uses.length === 0}
        <p class="opacity-70">No job uses this instance.</p>
      {:else}
        <h4 class="text-[11px] font-semibold tracking-wide uppercase opacity-60">Jobs using it</h4>
        <ul class="list-disc pl-5">
          {#each uses as u (u.job.id)}
            <li>{u.job.name} ({u.asSource && u.asTarget ? "source and target" : u.asSource ? "source" : "target"})</li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="space-y-2 border-t border-surface-200-800 pt-3" aria-label="Connection check">
      <div class="flex items-center justify-between gap-2">
        <h4 class="font-semibold">Connection check</h4>
        <button type="button" class="btn btn-sm preset-tonal-primary" disabled={checking} onclick={checkNow}>{checking ? "Checking…" : "Check now"}</button>
      </div>
      {#if error}<p class="text-sm text-error-500" role="alert">{error}</p>{/if}
      <InstanceCheckView {instance} />
    </section>
  {/if}

  {#key instance?.id ?? "new"}
    <InstanceForm {instance} first={!instance && map.instances.length === 0} jobs={map.jobs} {onsaved} {ondeleted} oncancel={onclose} />
  {/key}
</aside>
