import { describe, expect, test } from "bun:test";
import { render, useDom } from "../test/dom.ts";
import type { Run } from "./lib/runs.ts";

useDom();

const run = (id: string, over: Partial<Run> = {}): Run =>
  ({
    id,
    jobName: `Job ${id}`,
    trigger: "manual",
    dryRun: false,
    status: "completed",
    settings: { name: `Job ${id}`, dryRun: false, steps: [{ position: 0, operation: "sync_metadata", source: { id: "a", alias: "Home" }, target: { id: "b", alias: "Backup" }, options: {} }] },
    summary: null,
    createdAt: "2026-11-01T00:00:00Z",
    startedAt: "2026-11-01T00:00:00Z",
    finishedAt: null,
    steps: [],
    ...over,
  }) as unknown as Run;

describe("RunsTable", () => {
  test("shows status badges, a dry-run chip, step text and a dash for an unfinished run", async () => {
    const { default: RunsTable } = await import("./RunsTable.svelte");
    const root = render(RunsTable, { runs: [run("1", { dryRun: true }), run("2", { status: "completed_with_failures" })], onopen: () => {} });
    expect([...root.querySelectorAll("tbody .badge")].map((b) => b.textContent)).toEqual(["dry run", "completed", "completed with failures"]);
    expect(root.textContent).toContain("sync metadata Home to Backup · manual");
    expect(root.querySelector("caption")?.textContent).toContain("newest first");
    expect(root.querySelector("tbody tr td:nth-child(4)")?.textContent).toBe("-");
  });

  test("Open reports the run id and keeps a descriptive accessible name", async () => {
    const { default: RunsTable } = await import("./RunsTable.svelte");
    const opened: string[] = [];
    const root = render(RunsTable, { runs: [run("1"), run("2")], onopen: (id: string) => opened.push(id) });
    const buttons = root.querySelectorAll<HTMLButtonElement>("tbody button");
    expect(buttons[1]!.getAttribute("aria-label")).toContain("Open run Job 2 started");
    buttons[1]!.click();
    expect(opened).toEqual(["2"]);
  });
});
