import { describe, expect, test } from "bun:test";
import { flush, render, useDom } from "../../test/dom.ts";

useDom();

describe("Toggle", () => {
  test("renders a labelled switch with a hint and reports changes", async () => {
    const Toggle = (await import("./Toggle.svelte")).default;
    const seen: boolean[] = [];
    const root = render(Toggle, { checked: false, label: "Dry run", hint: "Report only", onchange: (v: boolean) => seen.push(v) });
    const label = root.querySelector("label")!;
    expect(label.textContent).toContain("Dry run");
    expect(label.textContent).toContain("Report only");
    const input = root.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(input.checked).toBe(false);
    label.click();
    flush();
    expect(seen).toEqual([true]);
    expect(input.checked).toBe(true);
  });
  test("a disabled toggle does not change", async () => {
    const Toggle = (await import("./Toggle.svelte")).default;
    const seen: boolean[] = [];
    const root = render(Toggle, { checked: true, disabled: true, label: "Per-asset lines", onchange: (v: boolean) => seen.push(v) });
    root.querySelector("label")!.click();
    flush();
    expect(seen).toEqual([]);
    expect(root.querySelector<HTMLInputElement>("input[type=checkbox]")!.disabled).toBe(true);
  });
});
