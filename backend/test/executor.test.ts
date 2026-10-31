import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { startFakeImmich, type FakeAsset } from "../../core/test/fake-immich.ts";
import { encryptSecret } from "../src/crypto.ts";
import { memoryInstanceStore } from "../src/instances/store.ts";
import type { StepInput, StepOptions } from "../src/jobs/validation.ts";
import { memoryJobStore } from "../src/jobs/store.ts";
import { coreRange, createCoreExecutor, rolesFor } from "../src/runs/executor.ts";
import { memoryRunStore } from "../src/runs/store.ts";
import { createJobRunServices } from "../src/services.ts";
import { SECRET } from "./helpers.ts";

let stops: Array<() => void> = [];
afterEach(() => {
  stops.forEach((s) => s());
  stops = [];
});

type Fake = ReturnType<typeof startFakeImmich>;
const fake = (o: Parameters<typeof startFakeImmich>[0] = {}): Fake => {
  const s = startFakeImmich(o);
  stops.push(s.stop);
  return s;
};
const bytes = (v: string) => new TextEncoder().encode(v);
const asset = (id: string, content: Uint8Array): FakeAsset => ({
  id, checksum: createHash("sha1").update(content).digest("base64"), ownerId: "u-1", originalFileName: `${id}.jpg`, originalMimeType: "image/jpeg",
  type: "IMAGE", visibility: "timeline", isTrashed: false, fileCreatedAt: "2026-05-10T12:00:00.000Z", fileModifiedAt: "2026-05-11T12:00:00.000Z",
  isFavorite: false, exifInfo: { fileSizeInByte: content.byteLength, dateTimeOriginal: "2026-05-10T12:00:00.000Z" },
});
const mutating = (s: Fake) => s.requests.filter((r) => r.method !== "GET" && !(r.method === "POST" && r.path === "/api/search/metadata"));

async function setup(source: Fake, target: Fake, over: { sourceKey?: string } = {}) {
  const instances = memoryInstanceStore();
  const src = await instances.create({ alias: "src", apiUrl: source.url, apiKeyEnc: encryptSecret(over.sourceKey ?? source.apiKey, SECRET), note: null, isDefault: false });
  const dst = await instances.create({ alias: "dst", apiUrl: target.url, apiKeyEnc: encryptSecret(target.apiKey, SECRET), note: null, isDefault: false });
  const runs = memoryRunStore();
  const executor = createCoreExecutor({ instances, secretKey: SECRET });
  const svc = createJobRunServices({ instances, jobs: memoryJobStore(), runs, executor });
  const step = (operation: StepInput["operation"], options: Partial<StepOptions> = {}): StepInput => ({
    operation, sourceId: src.id, targetId: dst.id, onFailure: "continue", onError: "stop",
    options: { range: null, kind: "all", metadata: false, dryRun: false, ...options },
  });
  const run = async (steps: StepInput[], dryRun = false) => {
    const started = await svc.manager.start({ job: { name: "t", steps }, trigger: "manual", ownerId: "99999999-9999-4999-8999-999999999999", startedBy: "admin", dryRun });
    await svc.manager.whenIdle();
    return { record: (await runs.getRun(started.id))!, events: runs.events.filter((e) => e.runId === started.id), svc };
  };
  return { run, step, svc, runs };
}

describe("core-backed executor", () => {
  test("dry run reports work and changes nothing on either server", async () => {
    const c = bytes("one");
    const source = fake({ assets: [asset("a1", c)], originals: { a1: c } });
    const target = fake();
    const { run, step } = await setup(source, target);
    const { record, events } = await run([step("copy")], true);
    expect(record.status).toBe("completed");
    expect(record.steps[0]).toMatchObject({ status: "completed", summary: { wouldCopy: 1, copied: 0, dryRun: true } });
    expect(mutating(source)).toHaveLength(0);
    expect(mutating(target)).toHaveLength(0);
    expect(target.uploadedMedia).toHaveLength(0);
    const assetEvent = events.find((e) => e.type === "asset");
    expect(assetEvent).toMatchObject({ level: "info", data: { step: 1, asset: { id: "a1", outcome: "would-copy" } } });
  });

  test("real copy uploads, logs asset and progress events, and a rerun skips", async () => {
    const c1 = bytes("one");
    const c2 = bytes("two");
    const source = fake({ assets: [asset("a1", c1), asset("a2", c2)], originals: { a1: c1, a2: c2 } });
    const target = fake();
    const { run, step } = await setup(source, target);
    const first = await run([step("copy")]);
    expect(first.record.status).toBe("completed");
    expect(first.record.steps[0]!.summary).toMatchObject({ copied: 2, assetsFound: 2 });
    expect(target.uploadedMedia).toHaveLength(2);
    expect(first.events.filter((e) => e.type === "asset")).toHaveLength(2);
    expect(first.events.some((e) => e.type === "progress" && (e.data as any).step === 1 && typeof (e.data as any).done === "number")).toBe(true);
    expect(first.events.some((e) => e.level === "debug")).toBe(false);
    expect(first.events.some((e) => e.type === "summary")).toBe(true);

    const second = await run([step("copy")]);
    expect(second.record.steps[0]!.summary).toMatchObject({ copied: 0, skipped: 2 });
    expect(target.uploadedMedia).toHaveLength(2);
  });

  test("move trashes the source asset only after the target is verified", async () => {
    const c = bytes("move me");
    const a = asset("a1", c);
    const source = fake({ assets: [a], originals: { a1: c } });
    const target = fake();
    const { run, step } = await setup(source, target);
    const { record } = await run([step("move")]);
    expect(record.status).toBe("completed");
    expect(record.steps[0]!.summary).toMatchObject({ moved: 1 });
    expect(target.uploadedMedia).toHaveLength(1);
    expect(a.isTrashed).toBe(true);
    const order = [...source.requests, ...target.requests].filter((r) => r.method !== "GET");
    expect(order.some((r) => r.method === "DELETE")).toBe(true);

    // A move whose upload fails must not trash the source.
    const c2 = bytes("keep me");
    const b = asset("b1", c2);
    const source2 = fake({ assets: [b], originals: { b1: c2 } });
    const target2 = fake({ uploadFailures: [b.originalFileName] });
    const t2 = await setup(source2, target2);
    const failed = await t2.run([t2.step("move")]);
    expect(failed.record.status).toBe("completed_with_failures");
    expect(b.isTrashed).toBe(false);
  });

  test("cancellation stops the step and trashes nothing unverified", async () => {
    const c1 = bytes("one");
    const c2 = bytes("two");
    const a1 = asset("a1", c1);
    const a2 = asset("a2", c2);
    let cancel = () => {};
    const source = fake({ assets: [a1, a2], originals: { a1: c1, a2: c2 }, onDownload: () => cancel() });
    const target = fake();
    const { run, step, svc } = await setup(source, target);
    cancel = () => svc.manager.activeRunIds().forEach((id) => svc.manager.cancel(id));
    const { record } = await run([step("move")]);
    expect(record.status).toBe("cancelled");
    expect(record.steps[0]!.status).toBe("cancelled");
    const uploaded = new Set(target.uploadedMedia.map((u) => u.fileName));
    for (const a of [a1, a2]) if (a.isTrashed) expect(uploaded.has(a.originalFileName)).toBe(true);
    expect(a2.isTrashed).toBe(false);
  });

  test("an instance check failure stops the run before any change, with no secrets logged", async () => {
    const c = bytes("one");
    const source = fake({ assets: [asset("a1", c)], originals: { a1: c } });
    const target = fake();
    const { run, step } = await setup(source, target, { sourceKey: "WRONG-KEY-VALUE" });
    const { record, events } = await run([step("copy"), step("copy")]);
    expect(record.status).toBe("failed");
    expect(record.steps.map((s) => s.status)).toEqual(["not_run", "not_run"]);
    expect(mutating(source)).toHaveLength(0);
    expect(mutating(target)).toHaveLength(0);
    expect(events.some((e) => e.level === "error" && /src: key check failed/.test(e.message ?? ""))).toBe(true);
    const text = JSON.stringify(events);
    expect(text).not.toContain("WRONG-KEY-VALUE");
    expect(text).not.toContain(source.url);
  });

  test("unsupported version and missing permissions are reported per instance", async () => {
    const old = fake({ version: { major: 3, minor: 1, patch: 0 } });
    const limited = fake({ permissions: ["user.read", "asset.read"] });
    const { run, step } = await setup(old, limited);
    const { events, record } = await run([step("copy")]);
    expect(record.status).toBe("failed");
    expect(events.map((e) => e.message).join("\n")).toMatch(/not supported/);
    const ok = fake();
    const t = await setup(ok, limited);
    const r = await t.run([t.step("copy")]);
    expect(r.events.map((e) => e.message).join("\n")).toMatch(/dst: The API key lacks permissions for target \(copy\) \(step 1\): asset\.upload/);
    expect(mutating(ok)).toHaveLength(0);
  });

  test("same server and user is refused", async () => {
    const one = fake();
    const instances = memoryInstanceStore();
    const a = await instances.create({ alias: "a", apiUrl: one.url, apiKeyEnc: encryptSecret(one.apiKey, SECRET), note: null, isDefault: false });
    const b = await instances.create({ alias: "b", apiUrl: one.url + "/", apiKeyEnc: encryptSecret(one.apiKey, SECRET), note: null, isDefault: false });
    const ex = createCoreExecutor({ instances, secretKey: SECRET });
    const opts = { range: null, kind: "all", metadata: false, dryRun: false } as const;
    const problems = await ex.validateInstances(
      [{ position: 1, operation: "copy", source: { id: a.id, alias: "a" }, target: { id: b.id, alias: "b" }, options: opts, onFailure: "continue", onError: "stop" }],
      { runId: "r", signal: new AbortController().signal, log: async () => {} },
    );
    expect(problems.map((p) => p.message).join()).toContain("same server and user");
  });

  test("maps options and roles", () => {
    const now = new Date("2026-06-10T00:00:00.000Z");
    expect(coreRange(null, now)).toBeUndefined();
    expect(coreRange({ lastDays: 2 }, now)).toEqual({ from: "2026-06-08T00:00:00.000Z", to: now.toISOString() });
    expect(coreRange({ to: "2026-01-01" }, now)).toEqual({ to: "2026-01-01" });
    const base = { position: 1, source: { id: "a", alias: "a" }, target: { id: "b", alias: "b" }, onFailure: "continue", onError: "stop" } as const;
    const o = { range: null, kind: "all", metadata: false, dryRun: false } as const;
    expect(rolesFor({ ...base, operation: "move", options: { ...o, metadata: true } })).toEqual({ source: ["source-move", "source-metadata"], target: ["target-metadata"] });
    expect(rolesFor({ ...base, operation: "copy", options: o })).toEqual({ source: ["source-copy"], target: ["target-copy"] });
    expect(rolesFor({ ...base, operation: "sync_metadata", options: { ...o, metadata: true } })).toEqual({ source: ["source-metadata"], target: ["target-metadata"] });
  });

  test("forwards options to core and tolerates unknown event kinds", async () => {
    const instances = memoryInstanceStore();
    const a = await instances.create({ alias: "a", apiUrl: "http://a.example/api", apiKeyEnc: encryptSecret("KEY-AAAAAA", SECRET), note: null, isDefault: false });
    const b = await instances.create({ alias: "b", apiUrl: "http://b.example/api", apiKeyEnc: encryptSecret("KEY-BBBBBB", SECRET), note: null, isDefault: false });
    let seen: any;
    const ex = createCoreExecutor({
      instances, secretKey: SECRET,
      run: async (o) => {
        seen = o;
        o.onEvent?.({ type: "future-thing" } as never);
        o.onEvent?.({ type: "progress", phase: "copying", done: 1, total: 2 });
        o.onEvent?.({ type: "warning", message: "talking to http://a.example/api with KEY-AAAAAA" });
        return { kind: "step-run", operation: o.operation, dryRun: true, status: "completed_with_failures", sourceAlias: "a", targetAlias: "b", warnings: [], assets: [], events: [], summary: { assetsFound: 0 } as never };
      },
    });
    const logged: any[] = [];
    const outcome = await ex.runStep({
      runId: "r", signal: new AbortController().signal, log: async (e) => void logged.push(e), position: 1, dryRun: true,
      step: { position: 1, operation: "copy", source: { id: a.id, alias: "a" }, target: { id: b.id, alias: "b" }, onFailure: "continue", onError: "stop",
        options: { range: { lastDays: 1 }, kind: "photos", metadata: true, includeAlbums: true, includeTags: true, dryRun: true } },
    });
    expect(outcome.status).toBe("completed_with_failures");
    expect(seen).toMatchObject({ operation: "copy", kind: "photos", metadata: true, includeAlbums: true, includeTags: true, createMissingAlbums: false, dryRun: true });
    expect(seen.range.from).toBeString();
    expect(logged[0]).toMatchObject({ level: "debug" });
    expect(JSON.stringify(logged)).not.toContain("KEY-AAAAAA");
    expect(JSON.stringify(logged)).not.toContain("a.example");
  });
});
