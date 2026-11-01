import { describe, expect, test } from "bun:test";
import { flush, render, useDom } from "../test/dom.ts";

useDom();

const radios = (root: HTMLElement) => [...root.querySelectorAll<HTMLInputElement>("input[name=operation]")];

describe("OperationPicker", () => {
  test("is a labelled fieldset of three native radios with the current one checked", async () => {
    const { default: Picker } = await import("./OperationPicker.svelte");
    const root = render(Picker, { value: "copy" });
    expect(root.querySelector("fieldset legend")?.textContent).toBe("Operation");
    expect(radios(root).map((r) => r.value)).toEqual(["copy", "move", "sync_metadata"]);
    expect(radios(root).find((r) => r.checked)?.value).toBe("copy");
    expect([...root.querySelectorAll("label")].map((l) => l.textContent?.trim())).toEqual(["Copy", "Move", "Sync metadata"]);
  });

  test("the verify-before-trash note appears only for a move, and picking the radio switches to it", async () => {
    const { default: Picker } = await import("./OperationPicker.svelte");
    const root = render(Picker, { value: "copy" });
    expect(root.querySelector("[role=note]")).toBeNull();
    const move = radios(root)[1]!;
    move.checked = true;
    move.dispatchEvent(new Event("change", { bubbles: true }));
    flush();
    expect(root.querySelector("[role=note]")?.textContent).toContain("Move with verify-before-trash");
    expect(root.querySelector("[role=note]")?.textContent).toContain("Nothing is permanently deleted");
  });
});
