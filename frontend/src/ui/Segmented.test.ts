import { describe, expect, test } from "bun:test";
import { flush, render, useDom } from "../../test/dom.ts";

useDom();

const OPTIONS = [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }, { value: "c", label: "Gamma", disabled: true }];
const radios = (root: HTMLElement) => [...root.querySelectorAll<HTMLInputElement>("input[type=radio]")];

describe("Segmented", () => {
  test("is a labelled radio group with hidden named inputs and the current value checked", async () => {
    const { default: Segmented } = await import("./Segmented.svelte");
    const root = render(Segmented, { options: OPTIONS, value: "b", ariaLabel: "Letters", name: "letters", onchange() {} });
    expect(root.querySelector("[role=radiogroup]")?.getAttribute("aria-label")).toBe("Letters");
    expect(radios(root).map((r) => r.value)).toEqual(["a", "b", "c"]);
    expect(radios(root).every((r) => r.name === "letters")).toBe(true);
    expect(radios(root).find((r) => r.checked)?.value).toBe("b");
    expect(radios(root)[2]!.disabled).toBe(true);
    expect(root.textContent).toContain("Alpha");
  });

  test("choosing another option reports its value once", async () => {
    const { default: Segmented } = await import("./Segmented.svelte");
    const got: string[] = [];
    const root = render(Segmented, { options: OPTIONS, value: "a", ariaLabel: "Letters", onchange: (v: string) => got.push(v) });
    radios(root)[1]!.click();
    flush();
    expect(got).toEqual(["b"]);
  });
});
