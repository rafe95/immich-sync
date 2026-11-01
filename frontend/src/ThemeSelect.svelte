<script lang="ts">
  import { applyPref, loadPref, savePref, THEME_LABEL, THEME_PREFS, type ThemePref } from "./lib/theme.ts";

  let pref = $state<ThemePref>(loadPref());

  // Several selectors can be on screen (header and Settings); keep them in step.
  const EVENT = "immich-sync:theme";
  $effect(() => {
    const sync = (e: Event) => (pref = (e as CustomEvent<ThemePref>).detail);
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  });

  function choose(p: ThemePref) {
    pref = p;
    savePref(p);
    applyPref(p);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: p }));
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
