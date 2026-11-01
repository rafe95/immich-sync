import { describe, expect, test } from "bun:test";
import { byText, flush, render, useDom } from "../../test/dom.ts";

useDom();

async function palette() {
  return (await import("./StepPalette.svelte")).default;
}

describe("StepPalette", () => {
  test("offers one button per operation", async () => {
    const root = render(await palette(), { onadd: () => {} });
    expect([...root.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Copy", "Move", "Sync metadata"]);
  });

  test("clicking a button reports that operation", async () => {
    const added: string[] = [];
    const root = render(await palette(), { onadd: (op: string) => added.push(op) });
    byText(root, "button", "Move").click();
    byText(root, "button", "Sync metadata").click();
    flush();
    expect(added).toEqual(["move", "sync_metadata"]);
  });

  test("disabled blocks every button", async () => {
    const added: string[] = [];
    const root = render(await palette(), { disabled: true, onadd: (op: string) => added.push(op) });
    const buttons = [...root.querySelectorAll("button")];
    expect(buttons.every((b) => b.disabled)).toBe(true);
    buttons[0]!.click();
    expect(added).toEqual([]);
  });

  test("enabled by default and draggable", async () => {
    const root = render(await palette(), { onadd: () => {} });
    const buttons = [...root.querySelectorAll("button")];
    expect(buttons.every((b) => !b.disabled && b.getAttribute("draggable") === "true")).toBe(true);
  });
});
