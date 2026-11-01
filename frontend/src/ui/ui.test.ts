import { describe, expect, test } from "bun:test";
import { byText, flush, render, settle, useDom } from "../../test/dom.ts";

useDom();

const progress = async () => (await import("./ProgressBar.svelte")).default;
const dialog = async () => (await import("./ConfirmDialog.svelte")).default;
const bar = (root: HTMLElement) => root.querySelector<HTMLElement>("[role=progressbar]")!;

describe("ProgressBar", () => {
  test("exposes a labelled determinate progressbar from value/max", async () => {
    const root = render(await progress(), { value: 3, max: 12, label: "Run progress" });
    expect(bar(root).getAttribute("aria-label")).toBe("Run progress");
    expect(bar(root).getAttribute("aria-valuenow")).toBe("3");
    expect(bar(root).getAttribute("aria-valuemax")).toBe("12");
  });

  test("percent shorthand uses a 0-100 scale", async () => {
    const root = render(await progress(), { percent: 40, label: "Step progress" });
    expect(bar(root).getAttribute("aria-valuenow")).toBe("40");
    expect(bar(root).getAttribute("aria-valuemax")).toBe("100");
  });

  test("a null value or unknown total is indeterminate", async () => {
    for (const props of [{ value: null, max: 5 }, { value: 2, max: null }]) {
      const root = render(await progress(), { ...props, label: "Run progress" });
      expect(bar(root).hasAttribute("aria-valuenow")).toBe(false);
      expect(bar(root).getAttribute("data-state")).toBe("indeterminate");
    }
  });
});

describe("ConfirmDialog", () => {
  const props = (over: Record<string, unknown> = {}) => ({ open: true, title: "Delete it?", confirmLabel: "Delete", onconfirm: () => {}, oncancel: () => {}, ...over });

  test("renders nothing while closed and an accessible alertdialog while open", async () => {
    const Dialog = await dialog();
    const closed = render(Dialog, props({ open: false }));
    expect(closed.textContent).not.toContain("Delete it?");
    const open = render(Dialog, props());
    const d = document.querySelector("[role=alertdialog]")!;
    expect(d).not.toBeNull();
    expect(d.textContent).toContain("Delete it?");
    expect(d.getAttribute("aria-labelledby")).toBeTruthy();
    expect(byText(open, "button", "Delete").className).toContain("preset-filled-primary-500");
  });

  test("danger tone styles the confirm button as an error action", async () => {
    const root = render(await dialog(), props({ tone: "danger" }));
    expect(byText(root, "button", "Delete").className).toContain("preset-filled-error-500");
  });

  test("confirm and cancel call their handlers; Escape cancels", async () => {
    const calls: string[] = [];
    const root = render(await dialog(), props({ onconfirm: () => calls.push("confirm"), oncancel: () => calls.push("cancel") }));
    byText(root, "button", "Delete").click();
    byText(root, "button", "Cancel").click();
    await settle();
    expect(calls).toEqual(["confirm", "cancel"]);
    document.querySelector("[role=alertdialog]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(calls).toEqual(["confirm", "cancel", "cancel"]);
  });

  test("busy disables both buttons", async () => {
    const root = render(await dialog(), props({ busy: true }));
    expect(byText(root, "button", "Delete").hasAttribute("disabled")).toBe(true);
    expect(byText(root, "button", "Cancel").hasAttribute("disabled")).toBe(true);
    flush();
  });
});
