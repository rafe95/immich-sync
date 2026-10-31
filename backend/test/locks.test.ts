import { describe, expect, test } from "bun:test";
import { InstanceLockManager, LockAbortedError, lockSetForSteps } from "../src/runs/locks.ts";

describe("lockSetForSteps", () => {
  test("locks targets and move sources only; copy sources are read-only", () => {
    expect(
      lockSetForSteps([
        { operation: "copy", sourceId: "A", targetId: "B" },
        { operation: "move", sourceId: "C", targetId: "B" },
        { operation: "sync_metadata", sourceId: "D", targetId: "E" },
      ]),
    ).toEqual(["B", "C", "E"]);
  });
});

describe("InstanceLockManager", () => {
  test("two runs writing the same target conflict; unrelated instances run in parallel", () => {
    const m = new InstanceLockManager();
    const a = m.tryAcquire("run1", ["B"]);
    expect(a.ok).toBe(true);
    const b = m.tryAcquire("run2", ["B"]);
    expect(b).toEqual({ ok: false, busy: [{ instanceId: "B", heldBy: "run1" }] });
    expect(m.tryAcquire("run3", ["C"]).ok).toBe(true);
  });

  test("acquisition is all-or-nothing", () => {
    const m = new InstanceLockManager();
    m.tryAcquire("run1", ["C"]);
    const r = m.tryAcquire("run2", ["B", "C"]);
    expect(r.ok).toBe(false);
    // B was not taken by the failed attempt
    expect(m.tryAcquire("run3", ["B"]).ok).toBe(true);
  });

  test("release is idempotent and lets a waiter proceed, with busy reporting", async () => {
    const m = new InstanceLockManager();
    const first = (m.tryAcquire("run1", ["B"]) as any).lock;
    let busy: unknown;
    const waiting = m.acquire("run2", ["B", "C"], { onBusy: (b) => (busy = b) });
    expect(busy).toEqual([{ instanceId: "B", heldBy: "run1" }]);
    expect(m.snapshot().waiting).toEqual([{ owner: "run2", instanceIds: ["B", "C"] }]);
    first.release();
    first.release();
    const second = await waiting;
    expect(m.snapshot().held.map((h) => h.instanceId).sort()).toEqual(["B", "C"]);
    second.release();
    expect(m.snapshot()).toEqual({ held: [], waiting: [] });
  });

  test("waiters are served in order among overlapping requests", async () => {
    const m = new InstanceLockManager();
    const first = (m.tryAcquire("run1", ["B"]) as any).lock;
    const order: string[] = [];
    const w2 = m.acquire("run2", ["B"]).then((l) => (order.push("run2"), l));
    const w3 = m.acquire("run3", ["B"]).then((l) => (order.push("run3"), l));
    first.release();
    (await w2).release();
    (await w3).release();
    expect(order).toEqual(["run2", "run3"]);
  });

  test("a later non-overlapping request is not blocked by a waiter", async () => {
    const m = new InstanceLockManager();
    m.tryAcquire("run1", ["B"]);
    void m.acquire("run2", ["B", "C"]);
    const free = await m.acquire("run3", ["D"]);
    expect(free.instanceIds).toEqual(["D"]);
  });

  test("an overlapping later request waits behind an earlier waiter even if its own locks are free", async () => {
    const m = new InstanceLockManager();
    const held = (m.tryAcquire("run1", ["B"]) as any).lock;
    const w2 = m.acquire("run2", ["B", "C"]);
    let got = false;
    const w3 = m.acquire("run3", ["C"]).then((l) => ((got = true), l));
    await Promise.resolve();
    expect(got).toBe(false);
    held.release();
    (await w2).release();
    (await w3).release();
  });

  test("aborting a wait rejects it, frees its place, and does not hold locks", async () => {
    const m = new InstanceLockManager();
    const held = (m.tryAcquire("run1", ["B"]) as any).lock;
    const ac = new AbortController();
    const waiting = m.acquire("run2", ["B"], { signal: ac.signal });
    ac.abort();
    await expect(waiting).rejects.toBeInstanceOf(LockAbortedError);
    held.release();
    expect(m.snapshot()).toEqual({ held: [], waiting: [] });
    await expect(m.acquire("x", ["B"], { signal: ac.signal })).rejects.toBeInstanceOf(LockAbortedError);
  });
});
