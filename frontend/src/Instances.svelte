<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, type Instance, type InstanceCheck } from "./lib/api.ts";
  import { api } from "./lib/session.svelte.ts";

  let instances = $state<Instance[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let notice = $state<{ kind: "error" | "ok"; text: string } | null>(null);
  let busyId = $state<string | null>(null);

  // Form: null = closed, "new" = add, otherwise the instance being edited.
  let editing = $state<Instance | "new" | null>(null);
  let form = $state({ alias: "", apiUrl: "", apiKey: "", note: "", isDefault: false });
  let formErrors = $state<string[]>([]);
  let saving = $state(false);
  let confirmDelete = $state<Instance | null>(null);

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

  async function load() {
    try {
      instances = await api.listInstances();
      loadError = null;
    } catch (e) {
      loadError = msg(e);
    } finally {
      loading = false;
    }
  }
  onMount(load);

  function openForm(target: Instance | "new") {
    editing = target;
    formErrors = [];
    form =
      target === "new"
        ? { alias: "", apiUrl: "", apiKey: "", note: "", isDefault: instances.length === 0 }
        : { alias: target.alias, apiUrl: target.apiUrl, apiKey: "", note: target.note ?? "", isDefault: target.isDefault };
  }

  function closeForm() {
    form.apiKey = "";
    editing = null;
  }

  async function runCheck(id: string) {
    busyId = id;
    try {
      const result = await api.checkInstance(id);
      instances = instances.map((i) => (i.id === id ? { ...i, lastCheck: result, lastCheckedAt: result.checkedAt } : i));
    } catch (e) {
      notice = { kind: "error", text: `Connection test failed to run: ${msg(e)}` };
    } finally {
      busyId = null;
    }
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!editing) return;
    saving = true;
    formErrors = [];
    try {
      const input: Record<string, unknown> = {
        alias: form.alias,
        apiUrl: form.apiUrl,
        note: form.note.trim() || null,
        isDefault: form.isDefault,
      };
      // An empty key field means "leave the stored key unchanged".
      if (form.apiKey.trim()) input.apiKey = form.apiKey;
      const saved = editing === "new" ? await api.createInstance(input) : await api.updateInstance(editing.id, input);
      closeForm();
      await load();
      notice = { kind: "ok", text: `Saved ${saved.alias}. Testing connection…` };
      await runCheck(saved.id);
      if (notice?.kind === "ok") notice = { kind: "ok", text: `Saved ${saved.alias}.` };
    } catch (err) {
      formErrors = err instanceof ApiError && err.problems.length ? err.problems : [msg(err)];
    } finally {
      saving = false;
    }
  }

  async function makeDefault(i: Instance) {
    busyId = i.id;
    try {
      await api.updateInstance(i.id, { isDefault: true });
      await load();
    } catch (e) {
      notice = { kind: "error", text: msg(e) };
    } finally {
      busyId = null;
    }
  }

  async function remove(i: Instance) {
    busyId = i.id;
    try {
      await api.deleteInstance(i.id);
      confirmDelete = null;
      notice = { kind: "ok", text: `Deleted ${i.alias}.` };
      await load();
    } catch (e) {
      // 409: still referenced by job steps; the backend message says so.
      notice = { kind: "error", text: msg(e) };
      confirmDelete = null;
    } finally {
      busyId = null;
    }
  }

  function summary(c: InstanceCheck | null): { label: string; cls: string } {
    if (!c) return { label: "Not checked", cls: "preset-tonal-surface" };
    if (!c.ok) return { label: "Failed", cls: "preset-tonal-error" };
    return c.warnings.length ? { label: "OK, with warnings", cls: "preset-tonal-warning" } : { label: "OK", cls: "preset-tonal-success" };
  }
  const stages = ["ping", "version", "key", "permissions"] as const;
  function stageState(c: InstanceCheck, stage: (typeof stages)[number]): "ok" | "failed" | "not run" {
    if (!c.error) return "ok";
    const failedAt = stages.indexOf(c.error.stage);
    const i = stages.indexOf(stage);
    return i < failedAt ? "ok" : i === failedAt ? "failed" : "not run";
  }
  // The core check runs ping, version, key, permissions in this order; version precedes key.
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h1 class="h3">Instances</h1>
    <button type="button" class="btn preset-filled-primary-500" onclick={() => openForm("new")}>Add instance</button>
  </div>

  {#if notice}
    <div class="card p-3 text-sm {notice.kind === 'error' ? 'preset-tonal-error' : 'preset-tonal-success'}" role={notice.kind === "error" ? "alert" : "status"}>
      <div class="flex items-start justify-between gap-2">
        <span>{notice.text}</span>
        <button type="button" class="btn-icon btn-icon-sm" aria-label="Dismiss message" onclick={() => (notice = null)}>×</button>
      </div>
    </div>
  {/if}

  {#if editing}
    <form class="card preset-outlined-surface-200-800 max-w-2xl space-y-3 p-4" onsubmit={save} aria-labelledby="form-title">
      <h2 id="form-title" class="h5">{editing === "new" ? "Add instance" : `Edit ${editing.alias}`}</h2>
      <label class="label">
        <span class="label-text">Alias</span>
        <input class="input" required bind:value={form.alias} autocomplete="off" />
      </label>
      <label class="label">
        <span class="label-text">API URL</span>
        <input class="input" type="url" required placeholder="https://photos.example.com/api" bind:value={form.apiUrl} autocomplete="off" />
      </label>
      <label class="label">
        <span class="label-text">API key</span>
        <input
          class="input"
          type="password"
          autocomplete="new-password"
          required={editing === "new"}
          placeholder={editing === "new" ? "" : "Leave empty to keep the stored key"}
          bind:value={form.apiKey}
        />
        <span class="text-xs opacity-70">Write-only: the key is encrypted by the backend and never shown again.</span>
      </label>
      <label class="label">
        <span class="label-text">Note (optional)</span>
        <input class="input" bind:value={form.note} autocomplete="off" />
      </label>
      <label class="flex items-center gap-2">
        <input class="checkbox" type="checkbox" bind:checked={form.isDefault} />
        <span>Default instance</span>
      </label>
      {#if formErrors.length}
        <ul class="list-disc pl-5 text-sm text-error-500" role="alert">
          {#each formErrors as p (p)}<li>{p}</li>{/each}
        </ul>
      {/if}
      <div class="flex gap-2">
        <button class="btn preset-filled-primary-500" type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        <button class="btn preset-tonal-surface" type="button" onclick={closeForm} disabled={saving}>Cancel</button>
      </div>
    </form>
  {/if}

  {#if loading}
    <p role="status">Loading instances…</p>
  {:else if loadError}
    <p class="text-error-500" role="alert">Could not load instances: {loadError}</p>
    <button class="btn preset-tonal-surface" type="button" onclick={load}>Retry</button>
  {:else if instances.length === 0}
    <p class="opacity-70">No instances registered yet. Add one to get started.</p>
  {:else}
    <ul class="space-y-3">
      {#each instances as i (i.id)}
        {@const s = summary(i.lastCheck)}
        <li class="card preset-outlined-surface-200-800 space-y-3 p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="min-w-0">
              <h2 class="h5 flex flex-wrap items-center gap-2">
                <span class="break-all">{i.alias}</span>
                {#if i.isDefault}<span class="badge preset-filled-primary-500">Default</span>{/if}
                <span class="badge {s.cls}">{s.label}</span>
              </h2>
              <p class="text-sm break-all opacity-70">{i.apiUrl}</p>
              {#if i.note}<p class="text-sm">{i.note}</p>{/if}
            </div>
            <div class="flex flex-wrap gap-2">
              <button class="btn btn-sm preset-tonal-primary" type="button" disabled={busyId === i.id} onclick={() => runCheck(i.id)}>
                {busyId === i.id ? "Testing…" : "Test connection"}
              </button>
              <button class="btn btn-sm preset-tonal-surface" type="button" onclick={() => openForm(i)}>Edit</button>
              {#if !i.isDefault}
                <button class="btn btn-sm preset-tonal-surface" type="button" disabled={busyId === i.id} onclick={() => makeDefault(i)}>Set default</button>
              {/if}
              <button class="btn btn-sm preset-tonal-error" type="button" onclick={() => (confirmDelete = i)}>Delete</button>
            </div>
          </div>

          {#if confirmDelete?.id === i.id}
            <div class="card preset-tonal-error flex flex-wrap items-center gap-2 p-3" role="alertdialog" aria-label="Confirm delete">
              <span>Delete {i.alias}? Its stored key is removed. This does not touch the Immich server.</span>
              <button class="btn btn-sm preset-filled-error-500" type="button" disabled={busyId === i.id} onclick={() => remove(i)}>Delete</button>
              <button class="btn btn-sm preset-tonal-surface" type="button" onclick={() => (confirmDelete = null)}>Cancel</button>
            </div>
          {/if}

          {#if i.lastCheck}
            {@const c = i.lastCheck}
            <div class="space-y-2 text-sm">
              <p class="opacity-70">
                Last checked {fmt(i.lastCheckedAt)}{c.latencyMs !== null ? ` · ping ${c.latencyMs} ms` : ""}
                {c.version ? ` · Immich ${c.version}${c.versionStatus === "untested" ? " (newer than tested)" : ""}` : ""}
                {c.user ? ` · key belongs to ${c.user.name || c.user.email}` : ""}
              </p>
              <ul class="flex flex-wrap gap-2" aria-label="Check stages">
                {#each stages as st (st)}
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
        </li>
      {/each}
    </ul>
  {/if}
</div>
