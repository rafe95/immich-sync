<script lang="ts">
  import Brand from "./Brand.svelte";
  import { ApiError } from "./lib/api.ts";
  import { login, session } from "./lib/session.svelte.ts";

  import { loginBody } from "./lib/users.ts";
  let username = $state("");
  let password = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      const b = loginBody(username, password);
      await login(b.username, b.password);
      password = "";
    } catch (err) {
      error = err instanceof ApiError || err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<main class="grid min-h-screen place-items-center p-6">
  <form class="card preset-outlined-surface-200-800 bg-surface-50-950 w-full max-w-sm space-y-4 rounded-2xl p-6 shadow-sm" onsubmit={submit} aria-labelledby="login-title">
    <Brand />
    <div>
      <h1 id="login-title" class="h4">Sign in</h1>
      <p class="text-sm opacity-70">Use your Immich Sync account.</p>
    </div>
    {#if session.error}
      <p class="preset-tonal-error rounded-lg px-3 py-2 text-sm" role="alert">Could not reach the backend: {session.error}</p>
    {/if}
    <label class="label">
      <span class="label-text font-semibold">Username</span>
      <input class="input" type="text" autocomplete="username" required bind:value={username} />
    </label>
    <label class="label">
      <span class="label-text font-semibold">Password</span>
      <input class="input" type="password" autocomplete="current-password" required bind:value={password} aria-describedby={error ? "login-error" : undefined} />
    </label>
    {#if error}
      <p id="login-error" class="preset-tonal-error rounded-lg px-3 py-2 text-sm" role="alert">{error}</p>
    {/if}
    <button class="btn preset-filled-primary-500 w-full font-semibold" type="submit" disabled={busy || !username.trim() || !password}>
      {busy ? "Signing in…" : "Sign in"}
    </button>
  </form>
</main>
