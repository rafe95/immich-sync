/** Light / dark / system theme preference. Skeleton's tokens use light-dark(), so `color-scheme` on <html> switches them. */
export type ThemePref = "system" | "light" | "dark";
export const THEME_PREFS: readonly ThemePref[] = ["system", "light", "dark"];
export const THEME_LABEL: Record<ThemePref, string> = { system: "System", light: "Light", dark: "Dark" };
const KEY = "immich-sync.theme.v1";

export const parsePref = (v: unknown): ThemePref => (v === "light" || v === "dark" ? v : "system");

export function loadPref(): ThemePref {
  try {
    return parsePref(localStorage.getItem(KEY));
  } catch {
    return "system";
  }
}

export function savePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
}

/** The CSS `color-scheme` value for a preference: system keeps both so the browser decides. */
export const colorScheme = (pref: ThemePref): string => (pref === "system" ? "light dark" : pref);

export function applyPref(pref: ThemePref, root: HTMLElement = document.documentElement): void {
  root.style.colorScheme = colorScheme(pref);
  if (pref === "system") root.removeAttribute("data-mode");
  else root.setAttribute("data-mode", pref);
}
