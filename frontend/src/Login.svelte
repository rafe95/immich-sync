<script lang="ts">
  import Brand from "./Brand.svelte";
  import { ApiError } from "./lib/api.ts";
  import { api, completeRecovery, login, session } from "./lib/session.svelte.ts";

  import { loginBody, MIN_PASSWORD_LENGTH } from "./lib/users.ts";
  let username = $state("");
  let password = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  // Admin password recovery: "request" asks for a token in the backend log, "reset" uses it.
  let view = $state<"login" | "request" | "reset">("login");
  let notice = $state<string | null>(null);
  let token = $state("");
  let next = $state("");
  let confirm = $state("");

  const message = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

  function show(v: typeof view) {
    view = v;
    error = null;
    if (v === "login") notice = null;
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      const b = loginBody(username, password);
      await login(b.username, b.password);
      password = "";
    } catch (err) {
      error = message(err);
    } finally {
      busy = false;
    }
  }

  async function requestToken(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      notice = await api.requestRecovery(username.trim());
      view = "reset";
    } catch (err) {
      error = message(err);
    } finally {
      busy = false;
    }
  }

  async function reset(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    if (next !== confirm) {
      error = "The passwords do not match.";
      return;
    }
    busy = true;
    try {
      await completeRecovery(token.trim(), next);
      token = next = confirm = "";
    } catch (err) {
      error = message(err);
    } finally {
      busy = false;
    }
  }
</script>

<main class="grid min-h-screen place-items-center p-6">
  {#if view === "login"}
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
      <button class="btn btn-sm preset-tonal w-full" type="button" onclick={() => show("request")}>Forgot admin password?</button>
    </form>
  {:else}
    <form
      class="card preset-outlined-surface-200-800 bg-surface-50-950 w-full max-w-sm space-y-4 rounded-2xl p-6 shadow-sm"
      onsubmit={view === "request" ? requestToken : reset}
      aria-labelledby="recovery-title"
    >
      <Brand />
      <div>
        <h1 id="recovery-title" class="h4">Reset admin password</h1>
        {#if view === "request"}
          <p class="text-sm opacity-70">
            A one-time reset token is written to the backend log, valid for 15 minutes. You need access to the server's logs,
            for example <code>docker compose logs app</code> or your NAS's container log viewer.
          </p>
        {/if}
      </div>
      {#if view === "request"}
        <label class="label">
          <span class="label-text font-semibold">Username</span>
          <input class="input" type="text" autocomplete="username" required bind:value={username} />
        </label>
      {:else}
        {#if notice}
          <p class="preset-tonal-success rounded-lg px-3 py-2 text-sm" role="status">
            {notice} Look for the <code>[recovery]</code> line, for example with <code>docker compose logs app</code>. It is valid for 15 minutes.
          </p>
        {/if}
        <label class="label">
          <span class="label-text font-semibold">Reset token</span>
          <input class="input font-mono" type="text" autocomplete="one-time-code" spellcheck="false" required bind:value={token} />
        </label>
        <label class="label">
          <span class="label-text font-semibold">New password</span>
          <input class="input" type="password" autocomplete="new-password" required minlength={MIN_PASSWORD_LENGTH} aria-describedby="recovery-pw-hint" bind:value={next} />
          <span id="recovery-pw-hint" class="text-xs opacity-70">At least {MIN_PASSWORD_LENGTH} characters.</span>
        </label>
        <label class="label">
          <span class="label-text font-semibold">Confirm new password</span>
          <input class="input" type="password" autocomplete="new-password" required bind:value={confirm} />
        </label>
      {/if}
      {#if error}
        <p class="preset-tonal-error rounded-lg px-3 py-2 text-sm" role="alert">{error}</p>
      {/if}
      {#if view === "request"}
        <button class="btn preset-filled-primary-500 w-full font-semibold" type="submit" disabled={busy || !username.trim()}>
          {busy ? "Sending…" : "Send reset token"}
        </button>
        <button class="btn btn-sm preset-tonal w-full" type="button" onclick={() => show("reset")}>I already have a token</button>
      {:else}
        <button class="btn preset-filled-primary-500 w-full font-semibold" type="submit" disabled={busy || !token.trim() || !next || !confirm}>
          {busy ? "Saving…" : "Set new password"}
        </button>
      {/if}
      <button class="btn btn-sm preset-tonal w-full" type="button" onclick={() => show("login")}>Back to sign in</button>
    </form>
  {/if}
</main>
