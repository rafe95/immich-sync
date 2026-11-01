import { describe, expect, test } from "bun:test";
import { render, useDom } from "../test/dom.ts";

useDom();

describe("RunSidePanels", () => {
  test("two labelled sections with static guidance and no live lock status", async () => {
    const { default: Panels } = await import("./RunSidePanels.svelte");
    const root = render(Panels, {});
    const sections = [...root.querySelectorAll("section")];
    expect(sections.map((s) => s.getAttribute("aria-labelledby"))).toEqual(["run-before-title", "run-locks-title"]);
    expect(root.textContent).toContain("never uploaded again");
    expect(root.textContent).toContain("the same target or moving from the same source");
    expect(root.textContent).not.toMatch(/both free|healthy/i);
  });
});
