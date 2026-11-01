<script lang="ts">
  import { statusClass, statusLabel, type Run } from "./lib/runs.ts";

  let { runs, onopen }: { runs: Run[]; onopen: (id: string) => void } = $props();

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "-");
  const stepText = (r: Run) => r.settings.steps.map((s) => `${s.operation.replace("_", " ")} ${s.source.alias} to ${s.target.alias}`).join("; ");
</script>

<div class="overflow-x-auto">
  <table class="table">
    <caption class="sr-only">Past and current runs, newest first</caption>
    <thead><tr><th>Started</th><th>Run</th><th>Status</th><th>Finished</th><th><span class="sr-only">Open</span></th></tr></thead>
    <tbody>
      {#each runs as r (r.id)}
        <tr>
          <td>{fmt(r.startedAt ?? r.createdAt)}</td>
          <td>
            <div>{r.jobName}{#if r.dryRun}{" "}<span class="badge preset-tonal-surface text-xs">dry run</span>{/if}</div>
            <div class="text-xs opacity-70">{stepText(r)} · {r.trigger}</div>
          </td>
          <td><span class="badge {statusClass(r.status)}">{statusLabel(r.status)}</span></td>
          <td>{fmt(r.finishedAt)}</td>
          <td><button type="button" class="btn btn-sm preset-tonal-surface" onclick={() => onopen(r.id)} aria-label={`Open run ${r.jobName} started ${fmt(r.startedAt ?? r.createdAt)}`}>Open</button></td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
