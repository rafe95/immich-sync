import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { runStep, type StepEvent, type StepOptions, type StepResult } from "../src/step.ts";
import { startFakeImmich, type FakeAsset } from "./fake-immich.ts";

let stops: Array<() => void> = [];
afterEach(() => {
  stops.forEach((stop) => stop());
  stops = [];
});

function fake(options: Parameters<typeof startFakeImmich>[0] = {}) {
  const server = startFakeImmich(options);
  stops.push(server.stop);
  return server;
}
type Fake = ReturnType<typeof fake>;

const bytes = (value: string) => new TextEncoder().encode(value);
const checksum = (content: Uint8Array) => createHash("sha1").update(content).digest("base64");

function mediaAsset(id: string, content: Uint8Array, overrides: Partial<FakeAsset> = {}): FakeAsset {
  return {
    id,
    checksum: checksum(content),
    ownerId: "u-1",
    originalFileName: `${id}.jpg`,
    originalMimeType: "image/jpeg",
    type: "IMAGE",
    visibility: "timeline",
    isTrashed: false,
    fileCreatedAt: "2026-05-10T12:00:00.000Z",
    fileModifiedAt: "2026-05-11T12:00:00.000Z",
    isFavorite: true,
    exifInfo: { fileSizeInByte: content.byteLength, dateTimeOriginal: "2026-05-10T12:00:00.000Z" },
    ...overrides,
  };
}

/** Virtual clock: sleeping advances time instantly. */
function clock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

function opts(source: Fake, target: Fake, overrides: Partial<StepOptions> = {}): StepOptions {
  const virtual = clock();
  return {
    source: { alias: "source", apiUrl: source.url, apiKey: source.apiKey },
    target: { alias: "target", apiUrl: target.url, apiKey: target.apiKey },
    operation: "copy",
    metadataWait: { timeoutMs: 10_000, initialDelayMs: 100, maxDelayMs: 1_000, sleep: virtual.sleep, now: virtual.now },
    ...overrides,
  };
}

const mutating = (server: Fake) =>
  server.requests.filter((r) => r.method !== "GET" && !(r.method === "POST" && r.path === "/api/search/metadata"));
const deletes = (server: Fake) => server.requests.filter((r) => r.method === "DELETE");

function expectAssetEvents(result: StepResult) {
  const fromEvents = result.events.filter((e): e is Extract<StepEvent, { type: "asset" }> => e.type === "asset").map((e) => e.asset);
  expect(fromEvents).toEqual(result.assets);
  expect(result.events.at(-1)).toEqual({ type: "summary", status: result.status, summary: result.summary });
}

describe("runStep copy", () => {
  test("copies and reports a normalized completed result", async () => {
    const content = bytes("copy me");
    const source = fake({ assets: [mediaAsset("a1", content)], originals: { a1: content } });
    const target = fake();
    const seen: StepEvent[] = [];

    const result = await runStep(opts(source, target, { onEvent: (e) => seen.push(e) }));

    expect(result).toMatchObject({ kind: "step-run", operation: "copy", dryRun: false, status: "completed", sourceVersion: "v3.3.3" });
    expect(result.assets[0]).toMatchObject({ outcome: "copied", transfer: "copied", metadata: "disabled", trashed: false });
    expect(result.summary).toMatchObject({ assetsFound: 1, copied: 1, bytesCopied: content.byteLength, failed: 0 });
    expect(target.uploadedMedia).toHaveLength(1);
    expect(deletes(source)).toHaveLength(0);
    expect(seen).toEqual(result.events);
    expect(seen[0]).toMatchObject({ type: "phase", phase: "preflight" });
    expectAssetEvents(result);

    const rerun = await runStep(opts(source, target));
    expect(rerun.assets[0]).toMatchObject({ outcome: "skipped", transfer: "already-present" });
    expect(target.uploadedMedia).toHaveLength(1);
  });

  test("with metadata, waits for the target to read metadata, then syncs fields", async () => {
    const content = bytes("copy meta");
    const source = fake({ assets: [mediaAsset("a1", content, { isFavorite: true, exifInfo: { description: "hello", dateTimeOriginal: "2026-05-10T12:00:00.000Z" } })], originals: { a1: content } });
    const target = fake({ deferExifGets: 2 });
    const virtual = clock();

    const result = await runStep(opts(source, target, {
      metadata: true,
      metadataWait: { initialDelayMs: 100, sleep: virtual.sleep, now: virtual.now },
    }));

    expect(result.status).toBe("completed");
    expect(result.assets[0]).toMatchObject({ outcome: "copied", metadata: "synced" });
    expect(result.assets[0]?.changedFields).toContain("description");
    expect(virtual.sleeps).toEqual([100, 200]);
    const reads = target.requests.filter((r) => r.method === "GET" && r.path === "/api/assets/uploaded-1");
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(result.events.some((e) => e.type === "phase" && e.phase === "metadata-wait")).toBe(true);
  });

  test("per-asset failure continues and yields completed_with_failures", async () => {
    const one = bytes("one");
    const two = bytes("two");
    const a1 = mediaAsset("a1", one);
    const a2 = mediaAsset("a2", two);
    const source = fake({ assets: [a1, a2], originals: { a1: one, a2: two } });
    const target = fake({ uploadFailures: [a1.originalFileName] });

    const result = await runStep(opts(source, target));

    expect(result.status).toBe("completed_with_failures");
    expect(result.summary).toMatchObject({ failed: 1, copied: 1 });
    expect(result.assets.find((a) => a.id === "a1")?.outcome).toBe("failed");
    expect(result.assets.find((a) => a.id === "a2")?.outcome).toBe("copied");
  });

  test("cancellation yields cancelled and uploads nothing further", async () => {
    const one = bytes("one");
    const two = bytes("two");
    const controller = new AbortController();
    const source = fake({
      assets: [mediaAsset("a1", one), mediaAsset("a2", two)],
      originals: { a1: one, a2: two },
      onDownload: () => controller.abort(),
    });
    const target = fake();

    const result = await runStep(opts(source, target, { signal: controller.signal }));

    expect(result.status).toBe("cancelled");
    expect(result.summary.cancelled).toBe(2);
    expect(target.uploadedMedia).toHaveLength(0);
  });
});

describe("runStep move", () => {
  test("moves: copy, verify, trash on source", async () => {
    const content = bytes("move me");
    const asset = mediaAsset("a1", content);
    const source = fake({ assets: [asset], originals: { a1: content } });
    const target = fake();

    const result = await runStep(opts(source, target, { operation: "move" }));

    expect(result.status).toBe("completed");
    expect(result.assets[0]).toMatchObject({ outcome: "moved", trashed: true, transfer: "copied" });
    expect(result.summary).toMatchObject({ moved: 1 });
    expect(asset.isTrashed).toBe(true);
    expect(deletes(source)[0]?.body).toEqual({ ids: ["a1"], force: false });
  });

  test("waits for target metadata before syncing and trashing", async () => {
    const content = bytes("move waits");
    const asset = mediaAsset("a1", content, { exifInfo: { description: "keep", dateTimeOriginal: "2026-05-10T12:00:00.000Z" } });
    const source = fake({ assets: [asset], originals: { a1: content } });
    const target = fake({ deferExifGets: 3 });
    const virtual = clock();

    const result = await runStep(opts(source, target, {
      operation: "move",
      metadata: true,
      metadataWait: { initialDelayMs: 50, sleep: virtual.sleep, now: virtual.now },
    }));

    expect(result.assets[0]).toMatchObject({ outcome: "moved", metadata: "synced", trashed: true });
    expect(virtual.sleeps.length).toBe(3);
    const update = target.requests.findIndex((r) => r.method === "PUT" && r.path === "/api/assets/uploaded-1");
    expect(update).toBeGreaterThan(-1);
    const readsBeforeUpdate = target.requests.slice(0, update).filter((r) => r.method === "GET" && r.path === "/api/assets/uploaded-1");
    expect(readsBeforeUpdate.length).toBeGreaterThanOrEqual(4);
    expect(asset.isTrashed).toBe(true);
  });

  test("metadata timeout reports failure and does not trash", async () => {
    const content = bytes("never ready");
    const asset = mediaAsset("a1", content);
    const source = fake({ assets: [asset], originals: { a1: content } });
    const target = fake({ deferExifGets: Infinity });

    const result = await runStep(opts(source, target, { operation: "move", metadata: true }));

    expect(result.status).toBe("completed_with_failures");
    expect(result.assets[0]).toMatchObject({ outcome: "failed", metadata: "failed", trashed: false });
    expect(result.assets[0]?.message).toContain("timed out");
    expect(asset.isTrashed).toBe(false);
    expect(deletes(source)).toHaveLength(0);
    expect(target.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    expect(target.uploadedMedia).toHaveLength(1);
  });

  test("cancellation during the metadata wait does not trash", async () => {
    const content = bytes("cancel wait");
    const asset = mediaAsset("a1", content);
    const source = fake({ assets: [asset], originals: { a1: content } });
    const target = fake({ deferExifGets: Infinity });
    const controller = new AbortController();

    const result = await runStep(opts(source, target, {
      operation: "move",
      metadata: true,
      signal: controller.signal,
      metadataWait: { sleep: async () => controller.abort(), now: () => 0 },
    }));

    expect(result.status).toBe("cancelled");
    expect(result.assets[0]).toMatchObject({ outcome: "cancelled", trashed: false });
    expect(asset.isTrashed).toBe(false);
    expect(deletes(source)).toHaveLength(0);
  });

  test("a target lacking metadata permissions is refused before any upload", async () => {
    const content = bytes("no perms");
    const source = fake({ assets: [mediaAsset("a1", content)], originals: { a1: content } });
    const target = fake({ permissions: ["user.read", "asset.read", "asset.upload"] });

    const result = await runStep(opts(source, target, { operation: "move", metadata: true }));

    expect(result.status).toBe("error");
    expect(result.error).toContain("asset.update");
    expect(target.uploadedMedia).toHaveLength(0);
    expect(deletes(source)).toHaveLength(0);
  });
});

describe("runStep sync_metadata", () => {
  test("syncs assets already on the target and uploads nothing", async () => {
    const present = bytes("present");
    const missing = bytes("missing");
    const trashed = bytes("trashed");
    const source = fake({
      assets: [
        mediaAsset("s1", present, { isFavorite: true }),
        mediaAsset("s2", missing),
        mediaAsset("s3", trashed),
      ],
      originals: { s1: present, s2: missing, s3: trashed },
    });
    const targetAsset = mediaAsset("t1", present, { isFavorite: false });
    const target = fake({ assets: [targetAsset, mediaAsset("t3", trashed, { isTrashed: true })] });

    const result = await runStep(opts(source, target, { operation: "sync_metadata" }));

    expect(result.status).toBe("completed");
    expect(result.assets.find((a) => a.id === "s1")).toMatchObject({ outcome: "synced", metadata: "synced", transfer: "already-present" });
    expect(result.assets.find((a) => a.id === "s2")).toMatchObject({ outcome: "skipped", transfer: "not-on-target" });
    expect(result.assets.find((a) => a.id === "s3")).toMatchObject({ outcome: "in-target-trash" });
    expect(targetAsset.isFavorite).toBe(true);
    expect(target.uploadedMedia).toHaveLength(0);
    expect(target.requests.some((r) => r.method === "POST" && r.path === "/api/assets")).toBe(false);
    expect(mutating(source)).toHaveLength(0);

    const rerun = await runStep(opts(source, target, { operation: "sync_metadata" }));
    expect(rerun.assets.find((a) => a.id === "s1")?.outcome).toBe("unchanged");
  });

  test("a metadata failure on one asset yields completed_with_failures", async () => {
    const one = bytes("one");
    const source = fake({ assets: [mediaAsset("s1", one, { isFavorite: true })] });
    const target = fake({ assets: [mediaAsset("t1", one, { isFavorite: false })], updateFailures: ["t1"] });

    const result = await runStep(opts(source, target, { operation: "sync_metadata" }));

    expect(result.status).toBe("completed_with_failures");
    expect(result.assets[0]?.outcome).toBe("failed");
  });
});

describe("runStep dry run and preflight", () => {
  for (const operation of ["copy", "move", "sync_metadata"] as const) {
    test(`dry run makes no mutation on either server (${operation})`, async () => {
      const present = bytes("present");
      const fresh = bytes("fresh");
      const source = fake({
        assets: [mediaAsset("s1", present, { isFavorite: true }), mediaAsset("s2", fresh)],
        originals: { s1: present, s2: fresh },
      });
      const targetAsset = mediaAsset("t1", present, { isFavorite: false });
      const target = fake({ assets: [targetAsset] });

      const result = await runStep(opts(source, target, { operation, dryRun: true, metadata: true }));

      expect(result.dryRun).toBe(true);
      expect(result.status).toBe("completed");
      expect(mutating(source)).toHaveLength(0);
      expect(mutating(target)).toHaveLength(0);
      expect(target.uploadedMedia).toHaveLength(0);
      expect(targetAsset.isFavorite).toBe(false);
      expect(result.warnings.some((w) => w.startsWith("Dry run"))).toBe(true);
      const s1 = result.assets.find((a) => a.id === "s1")!;
      expect(s1.outcome).toBe(operation === "move" ? "would-move" : "would-sync");
      expect(s1.metadata).toBe("would-update");
      const s2 = result.assets.find((a) => a.id === "s2")!;
      expect(s2.outcome).toBe(operation === "copy" ? "would-copy" : operation === "move" ? "would-move" : "skipped");
    });
  }

  test("reports a version mismatch warning", async () => {
    const content = bytes("v");
    const source = fake({ assets: [mediaAsset("a1", content)] });
    const target = fake({ version: { major: 3, minor: 4, patch: 0 } });

    const result = await runStep(opts(source, target, { dryRun: true }));

    expect(result.warnings.some((w) => w.includes("version mismatch"))).toBe(true);
    expect(result.events.some((e) => e.type === "warning" && e.message.includes("version mismatch"))).toBe(true);
    expect(result).toMatchObject({ sourceVersion: "v3.3.3", targetVersion: "v3.4.0" });
  });

  for (const operation of ["copy", "move", "sync_metadata"] as const) {
    test(`a failing instance preflight changes nothing (${operation})`, async () => {
      const content = bytes("pre");
      const source = fake({ assets: [mediaAsset("a1", content)], originals: { a1: content } });
      const target = fake();

      const result = await runStep({ ...opts(source, target, { operation }), target: { alias: "target", apiUrl: target.url, apiKey: "wrong" } });

      expect(result.status).toBe("error");
      expect(result.error).toBeTruthy();
      expect(result.error).not.toContain("wrong");
      expect(mutating(source)).toHaveLength(0);
      expect(mutating(target)).toHaveLength(0);
    });
  }

  test("refuses the same server and user", async () => {
    const server = fake({ assets: [mediaAsset("a1", bytes("x"))] });
    const result = await runStep(opts(server, server));
    expect(result.status).toBe("error");
    expect(mutating(server)).toHaveLength(0);
  });

  test("rejects invalid combinations as errors", async () => {
    const source = fake();
    const target = fake();
    const result = await runStep(opts(source, target, { operation: "copy", includeTags: true }));
    expect(result.status).toBe("error");
    const edits = await runStep(opts(source, target, { operation: "copy", includeEdits: true }));
    expect(edits.status).toBe("error");
    const meta = await runStep(opts(source, target, { operation: "sync_metadata", metadata: false }));
    expect(meta.status).toBe("error");
  });
});

/** A latch whose wait fails (instead of hanging the suite) when the event is not delivered live. */
function latch() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return {
    open,
    wait: () => Promise.race([opened, Bun.sleep(4_000).then(() => { throw new Error("first asset event was not delivered live"); })]),
  };
}

describe("runStep live events", () => {
  /** Holds the Nth call of a hook until the first asset event has been delivered through onEvent. */
  function liveProbe(holdCall: number) {
    const gate = latch();
    let calls = 0;
    let done = false;
    const delivered: string[] = [];
    const arrivedBeforeDone: boolean[] = [];
    return {
      hook: async () => { if (++calls === holdCall) await gate.wait(); },
      onEvent: (event: StepEvent) => {
        if (event.type !== "asset") return;
        delivered.push(event.asset.id);
        arrivedBeforeDone.push(!done);
        gate.open();
      },
      finished: () => { done = true; },
      delivered,
      arrivedBeforeDone,
    };
  }

  test("copy delivers an asset event before the engine resolves, with progress and no duplicates", async () => {
    const one = bytes("live one");
    const two = bytes("live two!");
    const probe = liveProbe(2);
    const source = fake({
      assets: [mediaAsset("a1", one), mediaAsset("a2", two)],
      originals: { a1: one, a2: two },
      onDownload: probe.hook,
    });
    const target = fake();

    const result = await runStep(opts(source, target, { onEvent: probe.onEvent }));
    probe.finished();

    expect(result.status).toBe("completed");
    expect(probe.arrivedBeforeDone).toEqual([true, true]);
    expect(probe.delivered).toEqual(result.assets.map((a) => a.id));
    expectAssetEvents(result);
    const progress = result.events.filter((e) => e.type === "progress");
    expect(progress).toEqual([
      { type: "progress", phase: "copying", done: 1, total: 2, bytesDone: one.byteLength, bytesTotal: one.byteLength + two.byteLength },
      { type: "progress", phase: "copying", done: 2, total: 2, bytesDone: one.byteLength + two.byteLength, bytesTotal: one.byteLength + two.byteLength },
    ]);
    // A progress event follows its asset event.
    const kinds = result.events.map((e) => e.type);
    expect(kinds.indexOf("asset")).toBeLessThan(kinds.indexOf("progress"));
    expect(JSON.stringify(result.events)).not.toContain(source.apiKey);
  });

  test("copy with metadata delivers the first asset once its metadata sync finished", async () => {
    const one = bytes("meta one");
    const two = bytes("meta two!");
    const probe = liveProbe(2);
    const source = fake({
      assets: [mediaAsset("a1", one), mediaAsset("a2", two)],
      originals: { a1: one, a2: two },
    });
    const target = fake({ onAssetUpdate: probe.hook });

    const result = await runStep(opts(source, target, { metadata: true, onEvent: probe.onEvent }));
    probe.finished();

    expect(result.status).toBe("completed");
    expect(probe.arrivedBeforeDone).toEqual([true, true]);
    expectAssetEvents(result);
    expect(result.events.some((e) => e.type === "progress" && e.phase === "metadata" && e.done === 1 && e.total === 2)).toBe(true);
  });

  test("move delivers each final outcome as the asset is trashed", async () => {
    const one = bytes("move one");
    const two = bytes("move two!");
    const probe = liveProbe(2);
    const source = fake({
      assets: [mediaAsset("a1", one), mediaAsset("a2", two)],
      originals: { a1: one, a2: two },
      onTrash: probe.hook,
    });
    const target = fake();

    const result = await runStep(opts(source, target, { operation: "move", onEvent: probe.onEvent }));
    probe.finished();

    expect(result.status).toBe("completed");
    expect(result.assets.map((a) => a.outcome)).toEqual(["moved", "moved"]);
    expect(probe.arrivedBeforeDone).toEqual([true, true]);
    expectAssetEvents(result);
    const phases = result.events.filter((e) => e.type === "progress").map((e) => e.type === "progress" ? `${e.phase}:${e.done}` : "");
    expect(phases).toEqual(["copying:1", "copying:2", "finalizing:1", "finalizing:2"]);
  });

  test("sync_metadata delivers an asset event before the second asset is updated", async () => {
    const one = bytes("sync one");
    const two = bytes("sync two!");
    const probe = liveProbe(2);
    const source = fake({
      assets: [mediaAsset("s1", one, { isFavorite: true }), mediaAsset("s2", two, { isFavorite: true })],
    });
    const target = fake({
      assets: [mediaAsset("t1", one, { isFavorite: false }), mediaAsset("t2", two, { isFavorite: false })],
      onAssetUpdate: probe.hook,
    });

    const result = await runStep(opts(source, target, { operation: "sync_metadata", onEvent: probe.onEvent }));
    probe.finished();

    expect(result.assets.map((a) => a.outcome)).toEqual(["synced", "synced"]);
    expect(probe.arrivedBeforeDone).toEqual([true, true]);
    expectAssetEvents(result);
  });

  test("sync_metadata keeps result order when skipped assets precede synced ones", async () => {
    const present = bytes("present");
    const missing = bytes("missing");
    const source = fake({ assets: [mediaAsset("s1", missing), mediaAsset("s2", present, { isFavorite: true })] });
    const target = fake({ assets: [mediaAsset("t2", present, { isFavorite: false })] });
    const seen: string[] = [];

    const result = await runStep(opts(source, target, {
      operation: "sync_metadata",
      onEvent: (e) => { if (e.type === "asset") seen.push(e.asset.id); },
    }));

    expect(seen).toEqual(result.assets.map((a) => a.id));
    expect(new Set(seen).size).toBe(seen.length);
    expectAssetEvents(result);
  });

  test("a throwing listener does not affect the run", async () => {
    const content = bytes("listener");
    const source = fake({ assets: [mediaAsset("a1", content)], originals: { a1: content } });
    const target = fake();
    const result = await runStep(opts(source, target, { onEvent: () => { throw new Error("boom"); } }));
    expect(result.status).toBe("completed");
    expectAssetEvents(result);
  });
});

describe("sync_metadata permissions", () => {
  const content = bytes("perm");
  const readOnlySource = ["user.read", "asset.read"];

  test("requires only read on the source and read + asset.update on the target (no asset.upload)", async () => {
    const source = fake({ assets: [mediaAsset("s1", content, { isFavorite: true })], permissions: readOnlySource });
    const target = fake({ assets: [mediaAsset("t1", content, { isFavorite: false })], permissions: ["user.read", "asset.read", "asset.update"] });

    const result = await runStep(opts(source, target, { operation: "sync_metadata" }));

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result.assets[0]).toMatchObject({ outcome: "synced" });
  });

  test("refuses a target without asset.update before any change", async () => {
    const source = fake({ assets: [mediaAsset("s1", content)] });
    const target = fake({ assets: [mediaAsset("t1", content)], permissions: ["user.read", "asset.read", "asset.upload"] });

    const result = await runStep(opts(source, target, { operation: "sync_metadata" }));

    expect(result.status).toBe("error");
    expect(result.error).toContain("asset.update");
    expect(mutating(target)).toHaveLength(0);
  });

  test("album and tag permissions are required only when those options are on", async () => {
    const source = fake({ assets: [mediaAsset("s1", content)], permissions: [...readOnlySource, "album.read"] });
    const target = fake({ assets: [mediaAsset("t1", content)], permissions: ["user.read", "asset.read", "asset.update"] });

    const albums = await runStep(opts(source, target, { operation: "sync_metadata", includeAlbums: true }));
    expect(albums.status).toBe("error");
    expect(albums.error).toContain("album.read");

    const tags = await runStep(opts(source, target, { operation: "sync_metadata", includeTags: true }));
    expect(tags.status).toBe("error");
    expect(tags.error).toContain("tag.");
    expect(mutating(target)).toHaveLength(0);

    const edits = await runStep(opts(source, target, { operation: "sync_metadata", includeEdits: true }));
    expect(edits.status).toBe("error");
    expect(edits.error).toContain("asset.edit");
    expect(mutating(target)).toHaveLength(0);
  });

  test("includeEdits copies the source's edits to a target without any through sync_metadata", async () => {
    const crop = { action: "crop" as const, parameters: { x: 1, y: 2, width: 30, height: 40 } };
    const targetAsset = mediaAsset("t1", content);
    const source = fake({ assets: [mediaAsset("s1", content, { edits: [crop] })], permissions: [...readOnlySource, "asset.edit.get"] });
    const target = fake({ assets: [targetAsset], permissions: ["user.read", "asset.read", "asset.update", "asset.edit.get", "asset.edit.create"] });

    const result = await runStep(opts(source, target, { operation: "sync_metadata", includeEdits: true }));

    expect(result.assets[0]).toMatchObject({ outcome: "synced" });
    expect(targetAsset.edits).toEqual([crop]);
  });
});

describe("runStep cancelled while planning", () => {
  /** The target aborts at its first checksum lookup, which happens while the plan is being built. */
  function cancelOnFirstLookup() {
    const controller = new AbortController();
    const state = { lookups: 0 };
    const onMetadataSearch = (checksum?: string) => {
      if (!checksum) return;
      state.lookups++;
      controller.abort();
    };
    return { controller, state, onMetadataSearch };
  }
  const sourceWithTwo = () => {
    const one = bytes("one");
    const two = bytes("two");
    return fake({ assets: [mediaAsset("a1", one), mediaAsset("a2", two)], originals: { a1: one, a2: two } });
  };

  for (const [name, operation, dryRun] of [
    ["a dry-run copy", "copy", true],
    ["a real copy", "copy", false],
    ["a move", "move", false],
    ["a sync_metadata step", "sync_metadata", false],
  ] as const) {
    test(`${name} ends as cancelled with nothing changed on either server`, async () => {
      const { controller, state, onMetadataSearch } = cancelOnFirstLookup();
      const source = sourceWithTwo();
      const target = fake({ onMetadataSearch });

      const result = await runStep(opts(source, target, { operation, dryRun, signal: controller.signal }));

      expect(result.status).toBe("cancelled");
      expect(result.assets).toHaveLength(0);
      expect(state.lookups).toBe(1);
      expect(mutating(source)).toHaveLength(0);
      expect(mutating(target)).toHaveLength(0);
      expect(target.uploadedMedia).toHaveLength(0);
      expect(deletes(source)).toHaveLength(0);
    });
  }
});
