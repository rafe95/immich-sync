/**
 * happy-dom lifecycle and mount helpers for component tests.
 * The DOM is registered in beforeAll and removed in afterAll, because `bun test` runs every package's tests in one
 * process and core/backend tests must not see browser globals. Import components dynamically after `useDom()` ran.
 */
import { afterAll, afterEach, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

type SvelteApi = typeof import("svelte");
let svelte: SvelteApi;
const mounted: Array<Record<string, unknown>> = [];

export function useDom() {
  beforeAll(async () => {
    GlobalRegistrator.register({ url: "http://localhost/" });
    svelte = await import("svelte");
  });
  afterEach(() => {
    for (const c of mounted.splice(0)) svelte.unmount(c);
    document.body.innerHTML = "";
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });
}

/** Mounts a component into document.body and flushes effects. */
export function render<P extends Record<string, unknown>>(component: unknown, props: P): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(svelte.mount(component as never, { target, props }) as Record<string, unknown>);
  svelte.flushSync();
  return target;
}

export const flush = () => svelte.flushSync();

/** Waits for pending promises and effects (e.g. after an awaited mocked API call). */
export async function settle() {
  await svelte.tick();
  await new Promise((r) => setTimeout(r, 0));
  svelte.flushSync();
}

export function byText(root: ParentNode, selector: string, text: string): HTMLElement {
  const hit = [...root.querySelectorAll<HTMLElement>(selector)].find((e) => e.textContent?.trim() === text);
  if (!hit) throw new Error(`No ${selector} with text "${text}"`);
  return hit;
}

export function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  svelte.flushSync();
}
