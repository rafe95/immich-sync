<script lang="ts">
  import { onMount } from "svelte";
  import type { UserRecord, UserRole } from "./lib/api.ts";
  import { api, session } from "./lib/session.svelte.ts";
  import { createUserBody, lastLoginText, newPasswordProblem, newUserProblems, roleLabel, ROLES, MIN_PASSWORD_LENGTH } from "./lib/users.ts";

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  let users = $state<UserRecord[]>([]);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let notice = $state<{ kind: "error" | "ok"; text: string } | null>(null);
  let busyId = $state<string | null>(null);

  async function load() {
    try {
      users = await api.listUsers();
      loaded = true;
      loadError = null;
    } catch (err) {
      loadError = msg(err);
    }
  }
  onMount(load);

  // Add user. Passwords live only in component state and are cleared after the attempt.
  let add = $state({ username: "", password: "", role: "user" as UserRole });
  let addProblems = $state<string[]>([]);
  let addBusy = $state(false);

  async function addUser(e: SubmitEvent) {
    e.preventDefault();
    notice = null;
    const form = { ...add, username: add.username.trim() };
    addProblems = newUserProblems(form);
    if (addProblems.length) return;
    addBusy = true;
    try {
      const u = await api.createUser(createUserBody(form));
      add = { username: "", password: "", role: "user" };
      notice = { kind: "ok", text: `User ${u.username} created.` };
      await load();
    } catch (err) {
      add.password = "";
      notice = { kind: "error", text: msg(err) };
    } finally {
      addBusy = false;
    }
  }

  async function changeRole(u: UserRecord, role: UserRole) {
    if (role === u.role) return;
    notice = null;
    busyId = u.id;
    try {
      await api.updateUser(u.id, { role });
      notice = { kind: "ok", text: `${u.username} is now ${roleLabel(role).toLowerCase()}.` };
    } catch (err) {
      notice = { kind: "error", text: msg(err) };
    } finally {
      busyId = null;
      await load(); // also resets the select to the stored role after a refused change
    }
  }

  // Password reset: one row at a time.
  let resetId = $state<string | null>(null);
  let resetPw = $state("");
  let resetProblem = $state<string | null>(null);
  async function resetPassword(e: SubmitEvent, u: UserRecord) {
    e.preventDefault();
    notice = null;
    resetProblem = newPasswordProblem(resetPw);
    if (resetProblem) return;
    busyId = u.id;
    try {
      await api.updateUser(u.id, { password: resetPw });
      notice = { kind: "ok", text: `Password for ${u.username} was reset.` };
      resetId = null;
    } catch (err) {
      notice = { kind: "error", text: msg(err) };
    } finally {
      resetPw = "";
      busyId = null;
    }
  }

  let confirmDeleteId = $state<string | null>(null);
  async function remove(u: UserRecord) {
    notice = null;
    busyId = u.id;
    try {
      await api.deleteUser(u.id);
      notice = { kind: "ok", text: `User ${u.username} deleted.` };
      confirmDeleteId = null;
      await load();
    } catch (err) {
      notice = { kind: "error", text: msg(err) };
    } finally {
      busyId = null;
    }
  }
</script>

<div class="space-y-6">
  <h1 class="h3">Users</h1>

  <div aria-live="polite" class="max-w-3xl">
    {#if notice}
      <p class="text-sm {notice.kind === 'error' ? 'text-error-500' : 'text-success-500'}" role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p>
    {/if}
  </div>

  <section class="card preset-outlined-surface-200-800 max-w-3xl space-y-3 p-4" aria-labelledby="users-title">
    <h2 id="users-title" class="h5">Accounts</h2>
    {#if loadError}
      <p class="text-error-500" role="alert">Could not load users: {loadError}</p>
      <button class="btn preset-tonal-surface" type="button" onclick={load}>Retry</button>
    {:else if !loaded}
      <p role="status">Loading…</p>
    {:else}
      <ul class="divide-y divide-surface-200-800">
        {#each users as u (u.id)}
          {@const isSelf = u.id === session.user?.id}
          <li class="space-y-2 py-3">
            <div class="flex flex-wrap items-center gap-3">
              <span class="font-medium">{u.username}</span>
              {#if isSelf}<span class="text-xs opacity-70">(you)</span>{/if}
              <span class="badge {u.role === 'admin' ? 'preset-tonal-primary' : 'preset-tonal-surface'}">{roleLabel(u.role)}</span>
              <span class="text-sm opacity-70">Last login: {lastLoginText(u.lastLoginAt)}</span>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <label class="flex items-center gap-2 text-sm">
                <span>Role</span>
                <select class="select w-28" value={u.role} disabled={busyId === u.id} onchange={(e) => changeRole(u, e.currentTarget.value as UserRole)} aria-label="Role for {u.username}">
                  {#each ROLES as r (r)}<option value={r}>{roleLabel(r)}</option>{/each}
                </select>
              </label>
              <button class="btn btn-sm preset-tonal-surface" type="button" disabled={busyId === u.id}
                onclick={() => { resetId = resetId === u.id ? null : u.id; resetPw = ""; resetProblem = null; confirmDeleteId = null; }}
                aria-expanded={resetId === u.id}>Reset password</button>
              {#if confirmDeleteId === u.id}
                <span class="text-sm">Delete {u.username}?</span>
                <button class="btn btn-sm preset-filled-error-500" type="button" disabled={busyId === u.id} onclick={() => remove(u)}>Confirm delete</button>
                <button class="btn btn-sm preset-tonal-surface" type="button" onclick={() => (confirmDeleteId = null)}>Cancel</button>
              {:else}
                <button class="btn btn-sm preset-tonal-error" type="button" disabled={busyId === u.id} onclick={() => { confirmDeleteId = u.id; resetId = null; }}>Delete</button>
              {/if}
            </div>
            {#if resetId === u.id}
              <form class="flex flex-wrap items-end gap-2" onsubmit={(e) => resetPassword(e, u)} novalidate>
                <label class="label">
                  <span class="label-text">New password for {u.username}</span>
                  <input class="input" type="password" autocomplete="new-password" required aria-describedby="reset-hint-{u.id}" bind:value={resetPw} />
                </label>
                <button class="btn preset-filled-primary-500" type="submit" disabled={busyId === u.id}>Set password</button>
                <span id="reset-hint-{u.id}" class="w-full text-xs {resetProblem ? 'text-error-500' : 'opacity-70'}" role={resetProblem ? "alert" : undefined}>{resetProblem ?? `At least ${MIN_PASSWORD_LENGTH} characters.`}</span>
              </form>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="card preset-outlined-surface-200-800 max-w-3xl space-y-3 p-4" aria-labelledby="add-title">
    <h2 id="add-title" class="h5">Add user</h2>
    <form class="space-y-3" onsubmit={addUser} novalidate>
      <label class="label">
        <span class="label-text">Username</span>
        <input class="input" type="text" autocomplete="off" required bind:value={add.username} />
      </label>
      <label class="label">
        <span class="label-text">Password</span>
        <input class="input" type="password" autocomplete="new-password" required aria-describedby="add-pw-hint" bind:value={add.password} />
        <span id="add-pw-hint" class="text-xs opacity-70">At least {MIN_PASSWORD_LENGTH} characters.</span>
      </label>
      <label class="label">
        <span class="label-text">Role</span>
        <select class="select w-40" bind:value={add.role}>
          {#each ROLES as r (r)}<option value={r}>{roleLabel(r)}</option>{/each}
        </select>
      </label>
      {#if addProblems.length}
        <ul class="list-disc pl-5 text-sm text-error-500" role="alert">
          {#each addProblems as p (p)}<li>{p}</li>{/each}
        </ul>
      {/if}
      <button class="btn preset-filled-primary-500" type="submit" disabled={addBusy}>{addBusy ? "Adding…" : "Add user"}</button>
    </form>
  </section>
</div>
