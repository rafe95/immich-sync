<script lang="ts">
  import { applyPref, loadPref, savePref, THEME_LABEL, THEME_PREFS, type ThemePref } from "./lib/theme.ts";

  let pref = $state<ThemePref>(loadPref());

  function choose(p: ThemePref) {
    pref = p;
    savePref(p);
    applyPref(p);
  }
</script>

<div class="flex items-center gap-1" role="group" aria-label="Colour theme">
  {#each THEME_PREFS as p (p)}
    <button
      type="button"
      class="btn btn-sm {pref === p ? 'preset-tonal-primary font-semibold' : 'hover:preset-tonal-surface'}"
      aria-pressed={pref === p}
      onclick={() => choose(p)}
    >{THEME_LABEL[p]}</button>
  {/each}
</div>
