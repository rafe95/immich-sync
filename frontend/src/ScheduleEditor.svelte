<script lang="ts">
  import { ApiError } from "./lib/api.ts";
  import { api } from "./lib/session.svelte.ts";
  import {
    browserTimezone, buildScheduleBody, cronFromForm, defaultScheduleForm, describeCron, filterTimezones, formatWhen, formFromSchedule, hasMove, isValidTimezone,
    needsMoveConfirmation, timezoneList, validateScheduleForm, WEEKDAYS, type JobRecord, type ScheduleForm, type ScheduleRecord,
  } from "./lib/jobs.ts";

  let { job, onsaved, onclose }: { job: JobRecord; onsaved: (schedule: ScheduleRecord | null) => void; onclose: () => void } = $props();

  // The editor is mounted fresh for each job, so the initial value is what we want.
  // svelte-ignore state_referenced_locally
  const existing = job.schedule;
  // svelte-ignore state_referenced_locally
  let form = $state<ScheduleForm>(existing ? formFromSchedule(existing) : defaultScheduleForm(browserTimezone()));
  let confirmMove = $state(false);
  let errors = $state<string[]>([]);
  let saving = $state(false);
  let saved = $state<ScheduleRecord | null>(existing);
  let tzQuery = $state("");

  const allZones = timezoneList();
  const zoneOptions = $derived(filterTimezones(allZones, tzQuery));
  const cron = $derived(cronFromForm(form));
  const reading = $derived(cron ? describeCron(cron) : null);
  const moves = $derived(hasMove(job.steps));
  const needsConfirm = $derived(needsMoveConfirmation(job.steps, form.enabled));
  const live = $derived(validateScheduleForm(form));

  async function save(e: SubmitEvent) {
    e.preventDefault();
    errors = [];
    const built = buildScheduleBody(form, confirmMove);
    if (!built.ok) {
      errors = built.problems;
      return;
    }
    if (needsConfirm && !confirmMove) {
      errors = ["Confirm that this schedule will trash assets on the source, unattended, before enabling it."];
      return;
    }
    saving = true;
    try {
      saved = await api.putSchedule(job.id, built.body);
      onsaved(saved);
    } catch (err) {
      errors = err instanceof ApiError && err.problems.length ? err.problems : [err instanceof Error ? err.message : String(err)];
    } finally {
      saving = false;
    }
  }

  async function remove() {
    saving = true;
    errors = [];
    try {
      await api.deleteSchedule(job.id);
      saved = null;
      onsaved(null);
    } catch (err) {
      errors = [err instanceof Error ? err.message : String(err)];
    } finally {
      saving = false;
    }
  }

  function toggleDay(d: number, on: boolean) {
    form.days = on ? [...new Set([...form.days, d])] : form.days.filter((x) => x !== d);
  }
</script>

<form class="card preset-outlined-surface-200-800 max-w-3xl space-y-4 p-4" onsubmit={save} aria-labelledby="sched-title">
  <h2 id="sched-title" class="h5">Schedule for "{job.name}"</h2>

  <fieldset class="space-y-2">
    <legend class="label-text">Repeat</legend>
    <div class="flex flex-wrap gap-4">
      {#each [["hourly", "Hourly"], ["daily", "Daily"], ["weekly", "Weekly"], ["custom", "Custom cron"]] as const as [value, label] (value)}
        <label class="flex items-center gap-2"><input class="radio" type="radio" name="preset" {value} bind:group={form.preset} /> {label}</label>
      {/each}
    </div>
    {#if form.preset === "hourly"}
      <label class="label max-w-xs"><span class="label-text">At minute</span><input class="input" type="number" min="0" max="59" bind:value={form.minute} /></label>
    {:else if form.preset === "daily" || form.preset === "weekly"}
      <label class="label max-w-xs"><span class="label-text">At time</span><input class="input" type="time" bind:value={form.time} required /></label>
    {/if}
    {#if form.preset === "weekly"}
      <fieldset>
        <legend class="label-text">On</legend>
        <div class="flex flex-wrap gap-3">
          {#each WEEKDAYS as name, d (d)}
            <label class="flex items-center gap-2"><input class="checkbox" type="checkbox" checked={form.days.includes(d)} onchange={(e) => toggleDay(d, e.currentTarget.checked)} /> {name.slice(0, 3)}</label>
          {/each}
        </div>
      </fieldset>
    {/if}
    {#if form.preset === "custom"}
      <label class="label">
        <span class="label-text">Cron expression (minute hour day-of-month month day-of-week)</span>
        <input class="input font-mono" bind:value={form.custom} placeholder="30 0 * * *" autocomplete="off" spellcheck="false" aria-describedby="cron-help" />
        <span id="cron-help" class="text-xs opacity-70">Five fields only, for example <code>0 3 * * 1-5</code> for 03:00 on weekdays. Seconds are not supported.</span>
      </label>
    {/if}
    <p class="text-sm" aria-live="polite">
      {#if cron}<code>{cron}</code>{#if reading} · {reading}{/if}{:else}<span class="opacity-70">Complete the fields to see the cron expression.</span>{/if}
    </p>
  </fieldset>

  <div class="grid gap-4 sm:grid-cols-2">
    <label class="label">
      <span class="label-text">Find a time zone</span>
      <input class="input" type="search" bind:value={tzQuery} placeholder="e.g. lisbon" autocomplete="off" />
    </label>
    <label class="label">
      <span class="label-text">Time zone (IANA)</span>
      <select class="select" bind:value={form.timezone} required>
        {#if !zoneOptions.includes(form.timezone) && isValidTimezone(form.timezone)}<option value={form.timezone}>{form.timezone}</option>{/if}
        {#each zoneOptions as z (z)}<option value={z}>{z}</option>{/each}
      </select>
    </label>
  </div>

  <label class="flex items-center gap-2">
    <input class="checkbox" type="checkbox" bind:checked={form.enabled} />
    <span>Enabled <span class="text-sm opacity-70">(untick to pause; the definition is kept)</span></span>
  </label>

  <label class="flex items-start gap-2">
    <input class="checkbox mt-1" type="checkbox" bind:checked={form.catchUp} />
    <span>
      Run once on start-up if a run was missed
      <span class="block text-sm opacity-70">Off by default: if the app was stopped at the scheduled time, that run is skipped.</span>
    </span>
  </label>

  {#if moves}
    <div class="rounded-container p-3 {needsConfirm ? 'preset-tonal-warning' : 'preset-tonal-surface'}" role="group" aria-label="Move confirmation">
      <label class="flex items-start gap-2">
        <input class="checkbox mt-1" type="checkbox" bind:checked={confirmMove} aria-required={needsConfirm} />
        <span>
          <strong>I confirm this schedule trashes assets.</strong>
          This job contains a move step. On every scheduled run, assets will be sent to the source's trash after they are verified on the target, with nobody asked first. Nothing is permanently deleted.
          {#if saved?.moveConfirmedAt}<span class="block text-sm opacity-70">Confirmed before on {formatWhen(saved.moveConfirmedAt)}; changing the job's steps requires confirming again.</span>{/if}
        </span>
      </label>
    </div>
  {/if}

  {#if saved?.enabled && saved.nextRuns.length}
    <div>
      <h3 class="label-text">Next runs (saved schedule, {saved.timezone})</h3>
      <ol class="list-decimal pl-5 text-sm">
        {#each saved.nextRuns as r (r)}<li>{formatWhen(r, saved.timezone)}</li>{/each}
      </ol>
    </div>
  {:else if saved && !saved.enabled}
    <p class="text-sm opacity-70">This schedule is paused, so nothing is due.</p>
  {:else}
    <p class="text-sm opacity-70">Save the schedule to see its next three run times.</p>
  {/if}

  {#if errors.length}
    <ul class="list-disc pl-5 text-sm text-error-500" role="alert">
      {#each errors as p (p)}<li>{p}</li>{/each}
    </ul>
  {:else if live.length}
    <p class="sr-only" aria-live="polite">{live.join(" ")}</p>
  {/if}

  <div class="flex flex-wrap gap-2">
    <button class="btn preset-filled-primary-500" type="submit" disabled={saving}>{saving ? "Saving…" : "Save schedule"}</button>
    {#if existing || saved}<button class="btn preset-tonal-error" type="button" disabled={saving} onclick={remove}>Remove schedule</button>{/if}
    <button class="btn preset-tonal-surface" type="button" onclick={onclose}>Close</button>
  </div>
</form>
