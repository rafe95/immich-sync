import { describe, expect, test } from "bun:test";
import { render, useDom } from "../test/dom.ts";
import type { JobRecord } from "./lib/jobs.ts";

useDom();

const job: JobRecord = {
  id: "j1", name: "Weekly", hasMove: true, createdAt: "", updatedAt: "",
  steps: [{ operation: "move", sourceId: "a", targetId: "b", options: { kind: "all", metadata: true }, onFailure: "continue", onError: "stop" }],
  schedule: { id: "s", jobId: "j1", cron: "0 3 * * 0", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: null, nextRuns: ["2099-01-04T03:00:00Z"] },
};

describe("ScheduleEditor", () => {
  test("renders the breadcrumb, segmented repeat, weekday chips, toggles, move notice and next runs", async () => {
    const ScheduleEditor = (await import("./ScheduleEditor.svelte")).default;
    let closed = 0;
    const root = render(ScheduleEditor, { job, onsaved() {}, onclose: () => closed++ });
    expect(root.querySelector("nav[aria-label=Breadcrumb]")!.textContent).toContain("Weekly");
    expect(root.querySelectorAll("input[type=radio][name=preset]")).toHaveLength(4);
    expect((root.querySelector("input[type=radio][value=weekly]") as HTMLInputElement).checked).toBe(true);
    expect(root.querySelectorAll("input[type=checkbox]:not([role=switch])").length).toBeGreaterThanOrEqual(8);
    expect(root.querySelectorAll("input[role=switch]")).toHaveLength(2);
    expect(root.querySelector("[role=group][aria-label='Move confirmation']")!.textContent).toContain("Scheduled move needs confirmation");
    expect(root.querySelector("aside")!.textContent).toContain("Next runs");
    expect(root.textContent).toContain("0 3 * * 0");
    expect(root.textContent).toContain("Remove schedule");
    root.querySelector<HTMLButtonElement>("nav button")!.click();
    expect(closed).toBe(1);
  });
  test("a move schedule cannot be saved without confirmation", async () => {
    const ScheduleEditor = (await import("./ScheduleEditor.svelte")).default;
    const root = render(ScheduleEditor, { job, onsaved() {}, onclose() {} });
    root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector("[role=alert]")!.textContent).toContain("Confirm that this schedule will trash assets");
  });
});
