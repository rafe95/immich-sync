<script lang="ts">
  import type { Instance } from "./lib/api.ts";
  import { CHECK_STAGES, stageState } from "./lib/instances.ts";

  let { instance }: { instance: Instance } = $props();
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");
  const c = $derived(instance.lastCheck);
</script>

{#if c}
  <div class="space-y-2 text-sm">
    <p class="opacity-70">
      Last checked {fmt(instance.lastCheckedAt)}{c.latencyMs !== null ? ` · ping ${c.latencyMs} ms` : ""}
      {c.version ? ` · Immich ${c.version}${c.versionStatus === "untested" ? " (newer than tested)" : ""}` : ""}
      {c.user ? ` · key belongs to ${c.user.name || c.user.email}` : ""}
    </p>
    <ul class="flex flex-wrap gap-2" aria-label="Check stages">
      {#each CHECK_STAGES as st (st)}
        {@const state = stageState(c, st)}
        <li class="badge {state === 'ok' ? 'preset-tonal-success' : state === 'failed' ? 'preset-tonal-error' : 'preset-tonal-surface'}">
          {st}: {state}
        </li>
      {/each}
    </ul>
    {#if c.error}
      <p class="text-error-500" role="alert">Failed at {c.error.stage}: {c.error.message}</p>
    {/if}
    {#each c.warnings as w (w)}
      <p class="text-warning-500">{w}</p>
    {/each}
    {#if c.roles}
      <ul class="space-y-1" aria-label="Permission roles">
        {#each Object.entries(c.roles) as [role, r] (role)}
          <li>
            <span class="badge {r.ok ? 'preset-tonal-success' : 'preset-tonal-error'}">{role}: {r.ok ? "ok" : "missing permissions"}</span>
            {#if !r.ok}<span class="opacity-70"> {r.missing.join(", ")}</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{:else}
  <p class="text-sm opacity-70">No connection test has been run yet.</p>
{/if}
