<script lang="ts">
  import { ApiError } from "./lib/api.ts";
  import { login, session } from "./lib/session.svelte.ts";

  let password = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      await login(password);
      password = "";
    } catch (err) {
      error = err instanceof ApiError || err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<main class="grid min-h-screen place-items-center p-6">
  <form class="card preset-outlined-surface-200-800 w-full max-w-sm space-y-4 p-6" onsubmit={submit}>
    <div class="flex items-center gap-3">
      <img src="/favicon.svg" alt="" class="size-7" />
      <h1 class="h4">Immich Sync</h1>
    </div>
    {#if session.error}
      <p class="text-sm text-error-500" role="alert">Could not reach the backend: {session.error}</p>
    {/if}
    <label class="label">
      <span class="label-text">Password</span>
      <input class="input" type="password" autocomplete="current-password" required bind:value={password} aria-describedby={error ? "login-error" : undefined} />
    </label>
    {#if error}
      <p id="login-error" class="text-sm text-error-500" role="alert">{error}</p>
    {/if}
    <button class="btn preset-filled-primary-500 w-full" type="submit" disabled={busy || !password}>
      {busy ? "Signing in…" : "Sign in"}
    </button>
  </form>
</main>
