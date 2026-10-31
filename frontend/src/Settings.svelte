<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "./lib/api.ts";
  import { api } from "./lib/session.svelte.ts";
  import { MAX_RETENTION_DAYS, MIN_PASSWORD_LENGTH, MIN_RETENTION_DAYS, parseRetentionDays, passwordProblems } from "./lib/settings.ts";

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // Passwords live only in these fields and are cleared after each attempt's outcome; never persisted.
  let pw = $state({ current: "", next: "", confirm: "" });
  let pwProblems = $state<string[]>([]);
  let pwNotice = $state<{ kind: "error" | "ok"; text: string } | null>(null);
  let pwBusy = $state(false);

  async function changePassword(e: SubmitEvent) {
    e.preventDefault();
    pwNotice = null;
    pwProblems = passwordProblems(pw);
    if (pwProblems.length) return;
    pwBusy = true;
    try {
      await api.changePassword(pw.current, pw.next);
      pw = { current: "", next: "", confirm: "" };
      pwNotice = { kind: "ok", text: "Password changed. All other sessions were signed out." };
    } catch (err) {
      pw.current = "";
      const retry = err instanceof ApiError && err.status === 429 ? " Wait before trying again." : "";
      pwNotice = { kind: "error", text: `${msg(err)}${retry}` };
    } finally {
      pwBusy = false;
    }
  }

  let retentionText = $state("");
  let retentionLoaded = $state(false);
  let retentionError = $state<string | null>(null);
  let retentionNotice = $state<{ kind: "error" | "ok"; text: string } | null>(null);
  let retentionBusy = $state(false);

  async function loadRetention() {
    try {
      retentionText = String(await api.getRetention());
      retentionLoaded = true;
      retentionError = null;
    } catch (err) {
      retentionError = msg(err);
    }
  }
  onMount(loadRetention);

  async function saveRetention(e: SubmitEvent) {
    e.preventDefault();
    retentionNotice = null;
    const parsed = parseRetentionDays(retentionText);
    if ("error" in parsed) {
      retentionNotice = { kind: "error", text: parsed.error };
      return;
    }
    retentionBusy = true;
    try {
      const days = await api.putRetention(parsed.days);
      retentionText = String(days);
      retentionNotice = { kind: "ok", text: `Run history is kept for ${days} days.` };
    } catch (err) {
      retentionNotice = { kind: "error", text: msg(err) };
    } finally {
      retentionBusy = false;
    }
  }
</script>

<div class="space-y-6">
  <h1 class="h3">Settings</h1>

  <section class="card preset-outlined-surface-200-800 max-w-2xl space-y-3 p-4" aria-labelledby="pw-title">
    <h2 id="pw-title" class="h5">Change password</h2>
    <form class="space-y-3" onsubmit={changePassword} novalidate>
      <label class="label">
        <span class="label-text">Current password</span>
        <input class="input" type="password" autocomplete="current-password" required bind:value={pw.current} />
      </label>
      <label class="label">
        <span class="label-text">New password</span>
        <input class="input" type="password" autocomplete="new-password" required minlength={MIN_PASSWORD_LENGTH} aria-describedby="pw-hint" bind:value={pw.next} />
        <span id="pw-hint" class="text-xs opacity-70">At least {MIN_PASSWORD_LENGTH} characters and different from the current one.</span>
      </label>
      <label class="label">
        <span class="label-text">Confirm new password</span>
        <input class="input" type="password" autocomplete="new-password" required bind:value={pw.confirm} />
      </label>
      {#if pwProblems.length}
        <ul class="list-disc pl-5 text-sm text-error-500" role="alert">
          {#each pwProblems as p (p)}<li>{p}</li>{/each}
        </ul>
      {/if}
      {#if pwNotice}
        <p class="text-sm {pwNotice.kind === 'error' ? 'text-error-500' : 'text-success-500'}" role={pwNotice.kind === "error" ? "alert" : "status"}>{pwNotice.text}</p>
      {/if}
      <button class="btn preset-filled-primary-500" type="submit" disabled={pwBusy}>{pwBusy ? "Changing…" : "Change password"}</button>
    </form>
  </section>

  <section class="card preset-outlined-surface-200-800 max-w-2xl space-y-3 p-4" aria-labelledby="ret-title">
    <h2 id="ret-title" class="h5">Run history</h2>
    {#if retentionError}
      <p class="text-error-500" role="alert">Could not load the setting: {retentionError}</p>
      <button class="btn preset-tonal-surface" type="button" onclick={loadRetention}>Retry</button>
    {:else if !retentionLoaded}
      <p role="status">Loading…</p>
    {:else}
      <form class="space-y-3" onsubmit={saveRetention} novalidate>
        <label class="label">
          <span class="label-text">Retention (days)</span>
          <input class="input w-40" type="text" inputmode="numeric" autocomplete="off" required aria-describedby="ret-hint" bind:value={retentionText} />
          <span id="ret-hint" class="text-xs opacity-70">Finished runs and their logs older than this are deleted ({MIN_RETENTION_DAYS} to {MAX_RETENTION_DAYS}).</span>
        </label>
        {#if retentionNotice}
          <p class="text-sm {retentionNotice.kind === 'error' ? 'text-error-500' : 'text-success-500'}" role={retentionNotice.kind === "error" ? "alert" : "status"}>{retentionNotice.text}</p>
        {/if}
        <button class="btn preset-filled-primary-500" type="submit" disabled={retentionBusy}>{retentionBusy ? "Saving…" : "Save"}</button>
      </form>
    {/if}
  </section>
</div>
