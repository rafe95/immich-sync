<script lang="ts">
  // Static guidance only: nothing here reflects live state (the app has no lock-status view).
</script>
<section class="card preset-outlined-surface-200-800 p-5" aria-labelledby="run-before-title">
  <h3 id="run-before-title" class="h6 mb-2">Before you start</h3>
  <ul class="list-disc space-y-1 pl-5 text-sm opacity-90">
    <li>The instances are checked first; a failed check stops the run.</li>
    <li>Assets already on the target are skipped, so reruns are safe.</li>
    <li>Assets found only in the target's trash are reported and never uploaded again.</li>
    <li>The run continues on the server if you close this tab.</li>
  </ul>
</section>
<section class="card preset-outlined-surface-200-800 p-5" aria-labelledby="run-locks-title">
  <h3 id="run-locks-title" class="h6 mb-2">Write locks</h3>
  <p class="text-sm opacity-90">A run waits when another job is writing to the same target or moving from the same source. Runs on unrelated instances can go in parallel.</p>
</section>
