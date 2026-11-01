<script lang="ts">
  import { ApiError } from "./lib/api.ts";
  import { relativeIn } from "./lib/jobCard.ts";
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

{#snippet toggle(label: string, hint: string, checked: boolean, onchange: (v: boolean) => void)}
  <label class="flex cursor-pointer items-start gap-3">
    <input
      type="checkbox"
      role="switch"
      class="relative mt-0.5 h-6 w-10 shrink-0 cursor-pointer appearance-none rounded-full bg-surface-300-700 transition-colors checked:bg-primary-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-surface-50 after:transition-transform after:content-[''] checked:after:translate-x-4"
      {checked}
      onchange={(e) => onchange(e.currentTarget.checked)}
    />
    <span>{label}<span class="block text-sm opacity-70">{hint}</span></span>
  </label>
{/snippet}

<div class="space-y-3">
  <nav aria-label="Breadcrumb" class="text-sm">
    <ol class="flex flex-wrap items-center gap-1.5">
      <li><button type="button" class="anchor" onclick={onclose}>Jobs</button></li>
      <li aria-hidden="true" class="opacity-60">/</li>
      <li class="opacity-80">{job.name}</li>
      <li aria-hidden="true" class="opacity-60">/</li>
      <li aria-current="page" class="font-semibold">Schedule</li>
    </ol>
  </nav>

  <form class="card preset-outlined-surface-200-800 bg-surface-50-950 max-w-5xl space-y-5 p-4 sm:p-5" onsubmit={save} aria-labelledby="sched-title">
    <h2 id="sched-title" class="h4">Schedule for "{job.name}"</h2>

    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div class="space-y-5">
        <fieldset class="space-y-3">
          <legend class="label-text">Repeat</legend>
          <div class="inline-flex max-w-full flex-wrap overflow-hidden rounded-container border border-surface-300-700">
            {#each [["hourly", "Hourly"], ["daily", "Daily"], ["weekly", "Weekly"], ["custom", "Custom cron"]] as const as [value, label] (value)}
              <label class="cursor-pointer px-4 py-2 text-sm has-checked:preset-filled-primary-500 has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-primary-500">
                <input class="sr-only" type="radio" name="preset" {value} bind:group={form.preset} />{label}
              </label>
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
              <div class="mt-1 flex flex-wrap gap-2">
                {#each WEEKDAYS as name, d (d)}
                  <label class="chip cursor-pointer preset-outlined-surface-300-700 has-checked:preset-filled-primary-500 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary-500">
                    <input class="sr-only" type="checkbox" checked={form.days.includes(d)} onchange={(e) => toggleDay(d, e.currentTarget.checked)} /><span aria-hidden="true">{name.slice(0, 3)}</span><span class="sr-only">{name}</span>
                  </label>
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

        <div class="space-y-3">
          {@render toggle("Enabled", "Untick to pause; the definition is kept.", form.enabled, (v) => (form.enabled = v))}
          {@render toggle("Run once on start-up if a run was missed", "Off by default: if the app was stopped at the scheduled time, that run is skipped.", form.catchUp, (v) => (form.catchUp = v))}
        </div>

        {#if moves}
          <div class="rounded-container border p-4 {needsConfirm ? 'preset-tonal-warning border-warning-500' : 'preset-tonal-surface border-surface-300-700'}" role="group" aria-label="Move confirmation">
            <p class="font-semibold">Scheduled move needs confirmation</p>
            <label class="mt-2 flex items-start gap-2">
              <input class="checkbox mt-1" type="checkbox" bind:checked={confirmMove} aria-required={needsConfirm} />
              <span>
                <strong>I confirm this schedule trashes assets.</strong>
                This job contains a move step. On every scheduled run, assets will be sent to the source's trash after they are verified on the target, with nobody asked first. Nothing is permanently deleted.
                {#if saved?.moveConfirmedAt}<span class="block text-sm opacity-70">Confirmed before on {formatWhen(saved.moveConfirmedAt)}; changing the job's steps requires confirming again.</span>{/if}
              </span>
            </label>
          </div>
        {/if}
      </div>

      <aside class="h-fit rounded-container preset-tonal-surface p-4" aria-labelledby="next-title">
        <h3 id="next-title" class="label-text">Next runs</h3>
        {#if saved?.enabled && saved.nextRuns.length}
          <p class="text-xs opacity-70">Saved schedule, {saved.timezone}, <code>{saved.cron}</code></p>
          <ol class="mt-2 list-decimal space-y-1 pl-5 text-sm">
            {#each saved.nextRuns as r (r)}{@const rel = relativeIn(r)}<li>{formatWhen(r, saved.timezone)}{#if rel} <span class="opacity-70">({rel})</span>{/if}</li>{/each}
          </ol>
        {:else if saved && !saved.enabled}
          <p class="mt-1 text-sm opacity-70">This schedule is paused, so nothing is due.</p>
        {:else}
          <p class="mt-1 text-sm opacity-70">Save the schedule to see its next three run times.</p>
        {/if}
      </aside>
    </div>

    {#if errors.length}
      <ul class="list-disc pl-5 text-sm text-error-500" role="alert">
        {#each errors as p (p)}<li>{p}</li>{/each}
      </ul>
    {:else if live.length}
      <p class="sr-only" aria-live="polite">{live.join(" ")}</p>
    {/if}

    <div class="flex flex-wrap gap-2">
      {#if existing || saved}<button class="btn preset-tonal-error" type="button" disabled={saving} onclick={remove}>Remove schedule</button>{/if}
      <span class="grow"></span>
      <button class="btn preset-tonal-surface" type="button" onclick={onclose}>Close</button>
      <button class="btn preset-filled-primary-500" type="submit" disabled={saving}>{saving ? "Saving…" : "Save schedule"}</button>
    </div>
  </form>
</div>
