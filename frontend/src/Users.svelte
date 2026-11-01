<script lang="ts">
  import { onMount } from "svelte";
  import type { UserDataCounts, UserRecord, UserRole } from "./lib/api.ts";
  import { api, session } from "./lib/session.svelte.ts";
  import { createUserBody, deletionWarning, lastLoginText, newPasswordProblem, newUserProblems, roleLabel, ROLES, MIN_PASSWORD_LENGTH } from "./lib/users.ts";

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
  let deleteCounts = $state<UserDataCounts | null>(null);
  let deleteError = $state<string | null>(null);
  let previewRequest = 0;
  function closeDelete() {
    previewRequest++;
    confirmDeleteId = null;
    deleteCounts = null;
    deleteError = null;
  }
  async function previewDelete(u: UserRecord) {
    const request = ++previewRequest;
    confirmDeleteId = u.id;
    resetId = null;
    deleteCounts = null;
    deleteError = null;
    try {
      const counts = await api.getUserData(u.id);
      if (request === previewRequest) deleteCounts = counts;
    } catch (err) {
      if (request === previewRequest) deleteError = msg(err);
    }
  }
  async function remove(u: UserRecord) {
    if (confirmDeleteId !== u.id || !deleteCounts || busyId !== null) return;
    notice = null;
    busyId = u.id;
    try {
      await api.deleteUser(u.id);
      notice = { kind: "ok", text: `User ${u.username} deleted.` };
      closeDelete();
      await load();
    } catch (err) {
      notice = { kind: "error", text: msg(err) };
      closeDelete();
      await load();
    } finally {
      busyId = null;
    }
  }
</script>

<div class="space-y-4">
  <h1 class="h3">Users</h1>

  <div aria-live="polite">
    {#if notice}
      <p class="rounded-lg px-3 py-2 text-sm {notice.kind === 'error' ? 'preset-tonal-error' : 'preset-tonal-success'}" role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p>
    {/if}
  </div>

  <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
  <section class="card preset-outlined-surface-200-800 bg-surface-50-950 space-y-3 rounded-2xl p-5" aria-labelledby="users-title">
    <h2 id="users-title" class="h5">Accounts</h2>
    {#if loadError}
      <p class="text-error-500" role="alert">Could not load users: {loadError}</p>
      <button class="btn preset-tonal-surface" type="button" onclick={load}>Retry</button>
    {:else if !loaded}
      <p role="status">Loading…</p>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full border-collapse text-left text-sm">
          <thead>
            <tr class="border-surface-200-800 border-b text-xs uppercase tracking-wide opacity-70">
              <th scope="col" class="px-2 py-2 font-semibold">User</th>
              <th scope="col" class="px-2 py-2 font-semibold">Role</th>
              <th scope="col" class="px-2 py-2 font-semibold">Last login</th>
              <th scope="col" class="px-2 py-2 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each users as u (u.id)}
              {@const isSelf = u.id === session.user?.id}
              <tr class="border-surface-200-800 border-b align-middle last:border-b-0">
                <th scope="row" class="px-2 py-3 font-medium">
                  {u.username}
                  {#if isSelf}<span class="text-xs font-normal opacity-70">(you)</span>{/if}
                  {#if u.deletingAt}<span class="badge preset-tonal-warning ml-1" role="status">Deleting…</span>{/if}
                </th>
                <td class="px-2 py-3">
                  <span class="badge {u.role === 'admin' ? 'preset-tonal-primary' : 'preset-tonal-surface'}">{roleLabel(u.role)}</span>
                </td>
                <td class="px-2 py-3 opacity-80">{lastLoginText(u.lastLoginAt)}</td>
                <td class="px-2 py-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <label class="flex items-center gap-2">
                      <span>Role</span>
                      <select class="select w-28" value={u.role} disabled={busyId !== null || !!u.deletingAt} onchange={(e) => changeRole(u, e.currentTarget.value as UserRole)} aria-label="Role for {u.username}">
                        {#each ROLES as r (r)}<option value={r}>{roleLabel(r)}</option>{/each}
                      </select>
                    </label>
                    <button class="btn btn-sm preset-tonal-surface" type="button" disabled={busyId !== null || !!u.deletingAt}
                      onclick={() => { resetId = resetId === u.id ? null : u.id; resetPw = ""; resetProblem = null; closeDelete(); }}
                      aria-expanded={resetId === u.id}>Reset password</button>
                    {#if confirmDeleteId !== u.id}
                      <button class="btn btn-sm preset-tonal-error" type="button" disabled={busyId !== null} onclick={() => previewDelete(u)}>{u.deletingAt ? "Retry delete" : "Delete"}</button>
                    {/if}
                  </div>
                </td>
              </tr>
              {#if confirmDeleteId === u.id}
                <tr class="border-surface-200-800 border-b">
                  <td colspan="4" class="px-2 pb-3">
                    <div class="preset-tonal-error space-y-2 rounded-xl p-3">
                      {#if deleteCounts}
                        <p class="text-sm" role="status">{deletionWarning(u.username, deleteCounts)}</p>
                      {:else if deleteError}
                        <p class="text-sm" role="alert">Could not load deletion counts: {deleteError}</p>
                        <button class="btn btn-sm preset-tonal-surface" type="button" onclick={() => previewDelete(u)}>Retry preview</button>
                      {:else}
                        <p class="text-sm" role="status">Loading deletion counts…</p>
                      {/if}
                      <div class="flex flex-wrap gap-2">
                        <button class="btn btn-sm preset-filled-error-500" type="button" disabled={busyId !== null || !deleteCounts} onclick={() => remove(u)}>Confirm delete</button>
                        <button class="btn btn-sm preset-tonal-surface" type="button" disabled={busyId !== null} onclick={closeDelete}>Cancel</button>
                      </div>
                    </div>
                  </td>
                </tr>
              {/if}
              {#if resetId === u.id}
                <tr class="border-surface-200-800 border-b">
                  <td colspan="4" class="px-2 pb-3">
                    <form class="preset-tonal-surface flex flex-wrap items-end gap-2 rounded-xl p-3" onsubmit={(e) => resetPassword(e, u)} novalidate>
                      <label class="label">
                        <span class="label-text">New password for {u.username}</span>
                        <input class="input" type="password" autocomplete="new-password" required aria-describedby="reset-hint-{u.id}" bind:value={resetPw} />
                      </label>
                      <button class="btn preset-filled-primary-500 font-semibold" type="submit" disabled={busyId === u.id}>Set password</button>
                      <span id="reset-hint-{u.id}" class="w-full text-xs {resetProblem ? 'text-error-500' : 'opacity-70'}" role={resetProblem ? "alert" : undefined}>{resetProblem ?? `At least ${MIN_PASSWORD_LENGTH} characters.`}</span>
                    </form>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <section class="card preset-outlined-surface-200-800 bg-surface-50-950 space-y-3 rounded-2xl p-5" aria-labelledby="add-title">
    <h2 id="add-title" class="h5">Add user</h2>
    <form class="space-y-3" onsubmit={addUser} novalidate>
      <div class="flex flex-wrap items-start gap-3">
        <label class="label min-w-48 flex-1">
          <span class="label-text font-semibold">Username</span>
          <input class="input" type="text" autocomplete="off" required bind:value={add.username} />
        </label>
        <label class="label min-w-48 flex-1">
          <span class="label-text font-semibold">Password</span>
          <input class="input" type="password" autocomplete="new-password" required aria-describedby="add-pw-hint" bind:value={add.password} />
          <span id="add-pw-hint" class="text-xs opacity-70">At least {MIN_PASSWORD_LENGTH} characters.</span>
        </label>
        <label class="label">
          <span class="label-text font-semibold">Role</span>
          <select class="select w-40" bind:value={add.role}>
            {#each ROLES as r (r)}<option value={r}>{roleLabel(r)}</option>{/each}
          </select>
        </label>
      </div>
      {#if addProblems.length}
        <ul class="preset-tonal-error list-disc rounded-lg py-2 pr-3 pl-7 text-sm" role="alert">
          {#each addProblems as p (p)}<li>{p}</li>{/each}
        </ul>
      {/if}
      <button class="btn preset-filled-primary-500 font-semibold" type="submit" disabled={addBusy}>{addBusy ? "Adding…" : "Add user"}</button>
    </form>
  </section>
  </div>
</div>
