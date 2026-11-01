<script lang="ts">
  import Brand from "./Brand.svelte";
  import { setupAdmin, session } from "./lib/session.svelte.ts";
  import { MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH, MIN_PASSWORD_LENGTH, MIN_USERNAME_LENGTH, setupProblems } from "./lib/users.ts";

  let username = $state("");
  let password = $state("");
  let confirm = $state("");
  let busy = $state(false);
  let problems = $state<string[]>([]);
  let error = $state<string | null>(null);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    problems = setupProblems({ username: username.trim(), password, confirm });
    if (problems.length) return;
    busy = true;
    try {
      await setupAdmin(username.trim(), password);
      password = confirm = "";
    } catch (err) {
      password = confirm = "";
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<main class="grid min-h-screen place-items-center p-6">
  <form class="card preset-outlined-surface-200-800 bg-surface-50-950 w-full max-w-md space-y-4 rounded-2xl p-6 shadow-sm" onsubmit={submit} novalidate aria-labelledby="setup-title">
    <Brand />
    <div class="space-y-1">
      <h1 id="setup-title" class="h4">Set up Immich Sync</h1>
      <p class="text-sm opacity-70">
        No account exists yet. The account you create here becomes the administrator; you can add other users afterwards from the Users page.
      </p>
    </div>
    {#if session.error}
      <p class="preset-tonal-error rounded-lg px-3 py-2 text-sm" role="alert">Could not reach the backend: {session.error}</p>
    {/if}
    <label class="label">
      <span class="label-text font-semibold">Username</span>
      <input class="input" type="text" autocomplete="username" required minlength={MIN_USERNAME_LENGTH} maxlength={MAX_USERNAME_LENGTH} aria-describedby="setup-user-hint" bind:value={username} />
      <span id="setup-user-hint" class="text-xs opacity-70">{MIN_USERNAME_LENGTH} to {MAX_USERNAME_LENGTH} characters: letters, digits, dot, underscore, hyphen.</span>
    </label>
    <label class="label">
      <span class="label-text font-semibold">Password</span>
      <input class="input" type="password" autocomplete="new-password" required maxlength={MAX_PASSWORD_LENGTH} aria-describedby="setup-pw-hint" bind:value={password} />
      <span id="setup-pw-hint" class="text-xs opacity-70">At least {MIN_PASSWORD_LENGTH} characters.</span>
    </label>
    <label class="label">
      <span class="label-text font-semibold">Confirm password</span>
      <input class="input" type="password" autocomplete="new-password" required bind:value={confirm} />
    </label>
    <div aria-live="polite">
      {#if problems.length}
        <ul class="preset-tonal-error list-disc rounded-lg py-2 pr-3 pl-7 text-sm" role="alert">
          {#each problems as p (p)}<li>{p}</li>{/each}
        </ul>
      {/if}
      {#if error}
        <p class="preset-tonal-error rounded-lg px-3 py-2 text-sm" role="alert">{error}</p>
      {/if}
    </div>
    <button class="btn preset-filled-primary-500 w-full font-semibold" type="submit" disabled={busy}>
      {busy ? "Creating account…" : "Create administrator account"}
    </button>
  </form>
</main>
