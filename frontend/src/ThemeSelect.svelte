<script lang="ts">
  import { applyPref, loadPref, savePref, THEME_LABEL, THEME_PREFS, type ThemePref } from "./lib/theme.ts";

  import Segmented from "./ui/Segmented.svelte";

  const THEME_OPTIONS = THEME_PREFS.map((p) => ({ value: p, label: THEME_LABEL[p] }));
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

<Segmented compact options={THEME_OPTIONS} value={pref} ariaLabel="Colour theme" onchange={choose} />
