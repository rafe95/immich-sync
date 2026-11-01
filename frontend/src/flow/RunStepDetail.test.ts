import { describe, expect, test } from "bun:test";
import { byText, flush, render, useDom } from "../../test/dom.ts";
import { initialConsole, type ConsoleState, type RunEvent } from "../lib/runs.ts";

useDom();

const component = async () => (await import("./RunStepDetail.svelte")).default;

function summary(step: number, sum: Record<string, unknown>): RunEvent {
  return { id: step, runId: "r1", ts: "2026-01-01T00:00:00Z", level: "info", type: "step_summary", message: `Step ${step} finished`, data: { step, status: "done", summary: sum } };
}

function state(patch: Partial<ConsoleState>): ConsoleState {
  return { ...initialConsole(), ...patch };
}

const tiles = (root: HTMLElement) => [...root.querySelectorAll("dl > div")].map((d) => `${d.querySelector("dt")!.textContent} ${d.querySelector("dd")!.textContent}`);

describe("RunStepDetail", () => {
  test("shows a hint until a step is selected", async () => {
    const root = render(await component(), { progress: initialConsole(), selected: null });
    expect(root.textContent).toContain("Select a step on the diagram");
    expect(root.querySelector("button")).toBeNull();
  });

  test("says no counts are reported for a step without a summary", async () => {
    const root = render(await component(), { progress: initialConsole(), selected: 2 });
    expect(root.textContent).toContain("Step 2");
    expect(root.textContent).toContain("No counts reported for this step yet.");
  });

  test("shows counts of the selected step only", async () => {
    const progress = state({
      summaries: [
        summary(1, { assetsFound: 10, copied: 7, skipped: 2, failed: 1, bytesCopied: 2048 }),
        summary(2, { assetsFound: 99, copied: 99 }),
      ],
    });
    const root = render(await component(), { progress, selected: 1 });
    expect(tiles(root)).toEqual(["Found 10", "copied 7", "Skipped 2", "In target trash 0", "Failed 1", "Bytes 2.00 KB"]);
    expect(root.textContent).not.toContain("99");
  });

  test("a dry run says would be", async () => {
    const progress = state({ summaries: [summary(1, { assetsFound: 5, dryRun: true, wouldMove: 3, inTargetTrash: 1 })] });
    const root = render(await component(), { progress, selected: 1 });
    expect(tiles(root)).toContain("Would be moved 3");
    expect(tiles(root)).toContain("In target trash 1");
    expect(root.textContent).toContain("never re-uploaded");
  });

  test("lists live failures of the selected step", async () => {
    const progress = state({
      failures: [
        { eventId: 1, step: 1, name: "IMG_1.jpg", message: "checksum mismatch" },
        { eventId: 2, step: 2, name: "IMG_2.jpg", message: null },
      ],
    });
    const root = render(await component(), { progress, selected: 1 });
    expect(root.querySelectorAll("li").length).toBe(1);
    expect(root.querySelector("li")!.textContent!.replace(/\s+/g, " ").trim()).toBe("IMG_1.jpg checksum mismatch");
    expect(root.textContent).not.toContain("IMG_2.jpg");
  });

  test("the failed tile is in the error tone only when something failed", async () => {
    const withFail = render(await component(), { progress: state({ summaries: [summary(1, { assetsFound: 3, copied: 2, failed: 1 })] }), selected: 1 });
    expect(withFail.querySelector(".preset-tonal-error")).not.toBeNull();
    const clean = render(await component(), { progress: state({ summaries: [summary(1, { assetsFound: 3, copied: 3 })] }), selected: 1 });
    expect(clean.querySelector(".preset-tonal-error")).toBeNull();
  });

  test("the title names the operation and instances when the step settings are given", async () => {
    const steps = [{ position: 1, operation: "move" as const, source: { id: "a", alias: "Phone" }, target: { id: "b", alias: "NAS" }, options: { range: null, kind: "all" as const, metadata: true, dryRun: false } }];
    const root = render(await component(), { progress: initialConsole(), selected: 1, steps });
    expect(root.textContent).toContain("Move Phone → NAS");
  });

  test("Show all steps clears the selection", async () => {
    const root = render(await component(), { progress: initialConsole(), selected: 1 });
    byText(root, "button", "Show all steps").click();
    flush();
    expect(root.textContent).toContain("Select a step on the diagram");
  });
});
