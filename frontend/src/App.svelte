<script lang="ts">
  import { onMount } from "svelte";
  import { getHealth, type Health } from "./lib/api.ts";

  // The five screens from SPEC.md, "User interface". Each is a placeholder until its phase.
  const screens = [
    { id: "dashboard", label: "Dashboard", blurb: "Running and queued jobs, next scheduled runs, last failures, instance health." },
    { id: "run", label: "Run", blurb: "One-off copy, move or metadata sync between two instances, with dry run." },
    { id: "jobs", label: "Jobs", blurb: "Saved and batch jobs, their steps and schedules." },
    { id: "history", label: "History", blurb: "Past runs and their logs, replayed in the console." },
    { id: "instances", label: "Instances", blurb: "Registered Immich servers, default instance, Test connection." },
  ] as const;

  let current = $state<(typeof screens)[number]["id"]>("dashboard");
  let health = $state<Health | null>(null);
  let healthError = $state<string | null>(null);

  const screen = $derived(screens.find((s) => s.id === current)!);

  onMount(async () => {
    try {
      health = await getHealth();
    } catch (err) {
      healthError = err instanceof Error ? err.message : String(err);
    }
  });
</script>

<div class="grid min-h-screen grid-rows-[auto_1fr]">
  <header class="flex items-center justify-between gap-4 border-b border-surface-200-800 px-6 py-3">
    <div class="flex items-center gap-3">
      <img src="/favicon.svg" alt="" class="size-7" />
      <span class="text-lg font-semibold">Immich Sync</span>
    </div>
    {#if health}
      <span class="badge {health.database ? 'preset-tonal-success' : 'preset-tonal-error'}">
        {health.database ? "Backend and database OK" : "Database unreachable"} · v{health.version}
      </span>
    {:else if healthError}
      <span class="badge preset-tonal-error">Backend unreachable</span>
    {:else}
      <span class="badge preset-tonal-surface">Checking backend…</span>
    {/if}
  </header>

  <div class="grid grid-cols-1 grid-rows-[auto_1fr] md:grid-cols-[14rem_1fr] md:grid-rows-1">
    <nav class="flex items-start gap-1 overflow-x-auto border-b border-surface-200-800 p-3 md:flex-col md:items-stretch md:border-r md:border-b-0">
      {#each screens as s (s.id)}
        <button
          type="button"
          class="btn justify-start {current === s.id ? 'preset-filled-primary-500' : 'hover:preset-tonal-surface'}"
          aria-current={current === s.id ? "page" : undefined}
          onclick={() => (current = s.id)}
        >
          {s.label}
        </button>
      {/each}
    </nav>

    <main class="space-y-4 p-6">
      <h1 class="h3">{screen.label}</h1>
      <div class="card preset-outlined-surface-200-800 max-w-2xl p-4">
        <p>{screen.blurb}</p>
        <p class="mt-2 text-sm opacity-70">Not built yet: see SPEC.md for what this screen will do.</p>
      </div>
    </main>
  </div>
</div>
