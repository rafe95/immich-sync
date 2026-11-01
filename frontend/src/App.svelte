<script lang="ts">
  import { onMount } from "svelte";
  import { getHealth, type Health } from "./lib/api.ts";
  import { checkSession, logout, session } from "./lib/session.svelte.ts";
  import Dashboard from "./Dashboard.svelte";
  import Jobs from "./Jobs.svelte";
  import Setup from "./Setup.svelte";
  import Users from "./Users.svelte";
  import { isAdmin } from "./lib/users.ts";
  import Login from "./Login.svelte";
  import Run from "./Run.svelte";
  import Settings from "./Settings.svelte";
  import History from "./History.svelte";
  import { formFromRun, type Run as RunRecord, type RunForm } from "./lib/runs.ts";

  // The screens from SPEC.md, "User interface". Dashboard is built by its own component.
  const screens = [
    { id: "dashboard", label: "Dashboard", enabled: true },
    { id: "run", label: "Run", enabled: true },
    { id: "jobs", label: "Jobs", enabled: true },
    { id: "history", label: "History", enabled: true },
    { id: "users", label: "Users", enabled: true },
    { id: "settings", label: "Settings", enabled: true },
  ] as const;
  // Users is for administrators only; the backend enforces the same rule.
  const visibleScreens = $derived(screens.filter((s) => s.id !== "users" || isAdmin(session.user)));

  let current = $state<(typeof screens)[number]["id"]>("dashboard");
  let health = $state<Health | null>(null);
  // Held here so leaving the Run or History screen and coming back keeps the run on screen (the run itself never depends on the page).
  let activeRunId = $state<string | null>(null);
  let historyRunId = $state<string | null>(null);
  let prefill = $state<RunForm | null>(null);
  function runRealFromHistory(run: RunRecord) {
    prefill = formFromRun(run);
    activeRunId = null;
    current = "run";
  }
  let healthError = $state<string | null>(null);

  onMount(async () => {
    checkSession();
    try {
      health = await getHealth();
    } catch (err) {
      healthError = err instanceof Error ? err.message : String(err);
    }
  });

  // After logging out or a 401, the next login starts on the dashboard.
  $effect(() => {
    if (session.status === "anonymous") {
      current = "dashboard";
      activeRunId = historyRunId = prefill = null;
    }
  });
</script>

{#if session.status === "loading"}
  <p class="p-6" role="status">Loading…</p>
{:else if session.needsSetup}
  <Setup />
{:else if session.status === "anonymous"}
  <Login />
{:else}
  <div class="grid min-h-screen grid-rows-[auto_1fr]">
    <header class="flex flex-wrap items-center justify-between gap-4 border-b border-surface-200-800 px-6 py-3">
      <div class="flex items-center gap-3">
        <img src="/favicon.svg" alt="" class="size-7" />
        <span class="text-lg font-semibold">Immich Sync</span>
      </div>
      <div class="flex items-center gap-3">
        {#if health}
          <span class="badge {health.database ? 'preset-tonal-success' : 'preset-tonal-error'}">
            {health.database ? "Backend and database OK" : "Database unreachable"} · v{health.version}
          </span>
        {:else if healthError}
          <span class="badge preset-tonal-error">Backend unreachable</span>
        {:else}
          <span class="badge preset-tonal-surface">Checking backend…</span>
        {/if}
        {#if session.user}
          <span class="text-sm">{session.user.username} <span class="badge preset-tonal-surface">{session.user.role}</span></span>
        {/if}
        <button type="button" class="btn btn-sm preset-tonal-surface" onclick={logout}>Log out</button>
      </div>
    </header>

    <div class="grid grid-cols-1 grid-rows-[auto_1fr] md:grid-cols-[14rem_1fr] md:grid-rows-1">
      <nav aria-label="Main" class="flex items-start gap-1 overflow-x-auto border-b border-surface-200-800 p-3 md:flex-col md:items-stretch md:border-r md:border-b-0">
        {#each visibleScreens as s (s.id)}
          <button
            type="button"
            class="btn justify-start whitespace-nowrap {current === s.id ? 'preset-filled-primary-500' : 'hover:preset-tonal-surface'}"
            aria-current={current === s.id ? "page" : undefined}
            disabled={!s.enabled}
            onclick={() => {
              if (s.id !== "run") prefill = null;
              current = s.id;
            }}
          >
            {s.label}{s.enabled ? "" : " (coming soon)"}
          </button>
        {/each}
      </nav>

      <main class="space-y-4 p-6">
        {#if current === "users" && isAdmin(session.user)}
          <Users />
        {:else if current === "settings"}
          <Settings />
        {:else if current === "run"}
          <Run bind:activeRunId {prefill} />
        {:else if current === "history"}
          <History bind:openId={historyRunId} onrunreal={runRealFromHistory} />
        {:else if current === "jobs"}
          <Jobs onrun={(id) => { activeRunId = id; prefill = null; current = "run"; }} />
        {:else}
          <Dashboard onopenrun={(id) => { historyRunId = id; current = "history"; }} />
        {/if}
      </main>
    </div>
  </div>
{/if}
