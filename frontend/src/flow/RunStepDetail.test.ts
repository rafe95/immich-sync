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
    const text = root.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("Found 10 · 7 copied · 2 skipped · 1 failed");
    expect(text).not.toContain("99");
  });

  test("a dry run says would be", async () => {
    const progress = state({ summaries: [summary(1, { assetsFound: 5, dryRun: true, wouldMove: 3, inTargetTrash: 1 })] });
    const root = render(await component(), { progress, selected: 1 });
    const text = root.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("3 would be moved");
    expect(text).toContain("1 in target trash (never re-uploaded)");
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
    expect(root.textContent).toContain("IMG_1.jpg: checksum mismatch");
  });

  test("Show all steps clears the selection", async () => {
    const root = render(await component(), { progress: initialConsole(), selected: 1 });
    byText(root, "button", "Show all steps").click();
    flush();
    expect(root.textContent).toContain("Select a step on the diagram");
  });
});
