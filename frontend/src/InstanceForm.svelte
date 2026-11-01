<script lang="ts">
  import Toggle from "./ui/Toggle.svelte";
  import { ApiError, type Instance } from "./lib/api.ts";
  import { api } from "./lib/session.svelte.ts";
  import type { JobRecord } from "./lib/jobs.ts";
  import { jobsUsing } from "./lib/instances.ts";

  // `instance` null = add. `first` makes a new instance the default. The parent re-keys this component per instance.
  let {
    instance,
    first = false,
    jobs,
    onsaved,
    ondeleted,
    oncancel,
  }: { instance: Instance | null; first?: boolean; jobs: JobRecord[]; onsaved: (i: Instance) => void; ondeleted?: (id: string) => void; oncancel: () => void } = $props();

  const initial = () => ({
    alias: instance?.alias ?? "",
    apiUrl: instance?.apiUrl ?? "",
    apiKey: "",
    note: instance?.note ?? "",
    isDefault: instance ? instance.isDefault : first,
  });
  let form = $state(initial());
  let errors = $state<string[]>([]);
  let saving = $state(false);
  let confirmDelete = $state(false);
  let deleting = $state(false);

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const uses = $derived(instance ? jobsUsing(instance.id, jobs) : []);

  async function save(e: SubmitEvent) {
    e.preventDefault();
    saving = true;
    errors = [];
    try {
      const input: Record<string, unknown> = { alias: form.alias, apiUrl: form.apiUrl, note: form.note.trim() || null, isDefault: form.isDefault };
      // An empty key field means "leave the stored key unchanged".
      if (form.apiKey.trim()) input.apiKey = form.apiKey;
      const saved = instance ? await api.updateInstance(instance.id, input) : await api.createInstance(input);
      form.apiKey = "";
      // Saving always re-tests the connection; a failing test is shown in the panel, it does not undo the save.
      await api.checkInstance(saved.id).catch(() => undefined);
      onsaved(saved);
    } catch (err) {
      errors = err instanceof ApiError && err.problems.length ? err.problems : [msg(err)];
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!instance) return;
    deleting = true;
    errors = [];
    try {
      await api.deleteInstance(instance.id);
      ondeleted?.(instance.id);
    } catch (err) {
      // 409: still referenced by job steps; the backend message says so.
      errors = [msg(err)];
      confirmDelete = false;
    } finally {
      deleting = false;
    }
  }
</script>

<form class="space-y-3" onsubmit={save} aria-label={instance ? `Edit ${instance.alias}` : "Add instance"}>
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
      required={!instance}
      placeholder={instance ? "Leave empty to keep the stored key" : ""}
      bind:value={form.apiKey}
    />
    <span class="text-xs opacity-70">Write-only: the key is encrypted by the backend and never shown again.</span>
  </label>
  <label class="label">
    <span class="label-text">Note (optional)</span>
    <input class="input" bind:value={form.note} autocomplete="off" />
  </label>
  <Toggle bind:checked={form.isDefault} label="Default instance" />
  {#if errors.length}
    <ul class="list-disc pl-5 text-sm text-error-500" role="alert">
      {#each errors as p (p)}<li>{p}</li>{/each}
    </ul>
  {/if}
  <div class="flex flex-wrap gap-2">
    <button class="btn preset-filled-primary-500" type="submit" disabled={saving || deleting}>{saving ? "Saving…" : "Save and check"}</button>
    <button class="btn preset-tonal-surface" type="button" onclick={oncancel} disabled={saving || deleting}>{instance ? "Close" : "Cancel"}</button>
    {#if instance && !confirmDelete}
      <button class="btn preset-tonal-error ml-auto" type="button" disabled={saving} onclick={() => (confirmDelete = true)}>Delete…</button>
    {/if}
  </div>
</form>

{#if instance && confirmDelete}
  <div class="card preset-tonal-error mt-3 space-y-2 p-3 text-sm" role="alertdialog" aria-label="Confirm delete">
    <p>Delete {instance.alias}? Its stored key is removed. This does not touch the Immich server.</p>
    {#if uses.length}
      <p>
        Jobs that use it: {uses.map((u) => u.job.name).join(", ")}. The delete is refused until those jobs stop using {instance.alias}.
      </p>
    {/if}
    <div class="flex gap-2">
      <button class="btn btn-sm preset-filled-error-500" type="button" disabled={deleting} onclick={remove}>{deleting ? "Deleting…" : "Delete"}</button>
      <button class="btn btn-sm preset-tonal-surface" type="button" disabled={deleting} onclick={() => (confirmDelete = false)}>Cancel</button>
    </div>
  </div>
{/if}
