import { describe, expect, mock, test } from "bun:test";
import { byText, render, useDom } from "../test/dom.ts";
import type { JobRecord } from "./lib/jobs.ts";
import type { Run } from "./lib/runs.ts";

useDom();

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: "j1", name: "Weekly", hasMove: true, createdAt: "", updatedAt: "",
  steps: [
    { operation: "move", sourceId: "a", targetId: "b", options: { kind: "all", metadata: true }, onFailure: "continue", onError: "stop" },
    { operation: "sync_metadata", sourceId: "b", targetId: "c", options: { kind: "all" }, onFailure: "continue", onError: "stop" },
  ],
  schedule: { id: "s", jobId: "j1", cron: "0 3 * * 0", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: null, nextRuns: ["2030-01-06T03:00:00Z"] },
  ...over,
});
const alias = (id: string) => ({ a: "Phone", b: "NAS", c: "Family" })[id] ?? "?";
const run = { id: "r", status: "completed_with_failures", createdAt: "2030-01-01T00:00:00Z", startedAt: null, finishedAt: "2030-01-01T01:00:00Z" } as unknown as Run;

async function mount(j: JobRecord, last: Run | null, handlers: Record<string, () => void> = {}) {
  const JobCard = (await import("./JobCard.svelte")).default;
  return render(JobCard, { job: j, last, alias, busy: false, onrun() {}, ondry() {}, onedit() {}, onschedule() {}, ondelete() {}, ...handlers });
}

describe("JobCard", () => {
  test("shows the pipeline chips, schedule state, unconfirmed-move warning and last result", async () => {
    const root = await mount(job(), run);
    const chips = root.querySelector("ol[aria-label=Steps]")!.textContent!;
    expect(chips).toContain("Move");
    expect(chips).toContain("Phone → NAS");
    expect(chips).toContain("Sync metadata");
    expect(root.textContent).toContain("Every Sunday at 03:00");
    expect(root.textContent).toContain("Move not confirmed");
    expect(root.textContent).toContain("completed with failures");
  });
  test("paused schedule and never-run job; no warning when paused", async () => {
    const j = job();
    const root = await mount({ ...j, schedule: { ...j.schedule!, enabled: false } }, null);
    expect(root.textContent).toContain("paused");
    expect(root.textContent).toContain("Never run");
    expect(root.textContent).not.toContain("Move not confirmed");
  });
  test("no schedule", async () => {
    expect((await mount(job({ schedule: null }), null)).textContent).toContain("No schedule");
  });
  test("action buttons call their handlers and keep accessible names", async () => {
    const h = { onrun: mock(() => {}), ondry: mock(() => {}), onedit: mock(() => {}), onschedule: mock(() => {}), ondelete: mock(() => {}) };
    const root = await mount(job(), null, h);
    byText(root, "button", "Run now").click();
    byText(root, "button", "Dry run").click();
    byText(root, "button", "Edit Weekly").click();
    byText(root, "button", "Schedule for Weekly").click();
    byText(root, "button", "Delete Weekly").click();
    for (const f of Object.values(h)) expect(f).toHaveBeenCalledTimes(1);
  });
});
