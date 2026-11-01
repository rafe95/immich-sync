import { describe, expect, test } from "bun:test";
import type { StepContext } from "../src/runs/executor.ts";
import { FakeExecutor } from "./fake-executor.ts";

const ctx = (position: number) => ({ position, dryRun: false, signal: new AbortController().signal, log: async () => {} }) as unknown as StepContext;

describe("FakeExecutor start tracking", () => {
  test("hasStarted stays resolved once any run has started that position", async () => {
    const ex = new FakeExecutor();
    await ex.runStep(ctx(1));
    // A later run has not started, yet hasStarted(1) is already true: waiting on it cannot tell the runs apart.
    await expect(Promise.race([ex.hasStarted(1).then(() => "resolved"), Bun.sleep(20).then(() => "pending")])).resolves.toBe("resolved");
  });

  test("nextStart waits for the next start of that position, not for one that already happened", async () => {
    const ex = new FakeExecutor();
    await ex.runStep(ctx(1));
    let started = false;
    const next = ex.nextStart(1).then(() => (started = true));

    await Bun.sleep(20);
    expect(started).toBe(false);
    await ex.runStep(ctx(1));
    await next;
    expect(started).toBe(true);
  });

  test("nextStart only resolves for its own position", async () => {
    const ex = new FakeExecutor();
    let started = false;
    const next = ex.nextStart(2).then(() => (started = true));

    await ex.runStep(ctx(1));
    await Bun.sleep(20);
    expect(started).toBe(false);
    await ex.runStep(ctx(2));
    await next;
    expect(started).toBe(true);
  });
});
