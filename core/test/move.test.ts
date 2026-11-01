import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { moveAssets, type MoveOptions, type MoveResult } from "../src/move.ts";
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

const bytes = (value: string) => new TextEncoder().encode(value);
const checksum = (content: Uint8Array) => createHash("sha1").update(content).digest("base64");

function mediaAsset(
  id: string,
  content: Uint8Array,
  type: "IMAGE" | "VIDEO" = "IMAGE",
  overrides: Partial<FakeAsset> = {},
): FakeAsset {
  return {
    id,
    checksum: checksum(content),
    ownerId: "u-1",
    originalFileName: `${id}.${type === "VIDEO" ? "mov" : "jpg"}`,
    originalMimeType: type === "VIDEO" ? "video/quicktime" : "image/jpeg",
    type,
    visibility: "timeline",
    isTrashed: false,
    fileCreatedAt: "2026-05-10T12:00:00.000Z",
    fileModifiedAt: "2026-05-11T12:00:00.000Z",
    isFavorite: true,
    exifInfo: { fileSizeInByte: content.byteLength, dateTimeOriginal: "2026-05-10T12:00:00.000Z" },
    ...overrides,
  };
}

function options(
  source: ReturnType<typeof fake>,
  target: ReturnType<typeof fake>,
  overrides: Partial<MoveOptions> = {},
): MoveOptions {
  return {
    source: { alias: "source", apiUrl: source.url, apiKey: source.apiKey },
    target: { alias: "target", apiUrl: target.url, apiKey: target.apiKey },
    operation: "move",
    metadataSync: false,
    ...overrides,
  };
}

async function runMove(input: MoveOptions): Promise<MoveResult> {
  const result = await moveAssets(input);
  if (result.kind !== "move-run") throw new Error("Expected an executing move result.");
  return result;
}

const trashRequests = (server: ReturnType<typeof fake>) =>
  server.requests.filter((request) => request.method === "DELETE");

describe("moveAssets", () => {
  test("copies, verifies on target, then trashes on the source without force", async () => {
    const content = bytes("move me");
    const asset = mediaAsset("a1", content);
    const source = fake({ assets: [asset], originals: { a1: content } });
    const target = fake();

    const result = await runMove(options(source, target));

    expect(result.assets[0]).toMatchObject({ status: "trashed", copyStatus: "copied", trashedIds: ["a1"] });
    expect(result.summary).toMatchObject({ assetsFound: 1, trashed: 1, notTrashed: 0, copied: 1 });
    expect(result.events.at(-1)).toEqual({ type: "summary", summary: result.summary });
    expect(asset.isTrashed).toBe(true);
    expect(target.uploadedMedia).toHaveLength(1);
    const deletes = trashRequests(source);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.body).toEqual({ ids: ["a1"], force: false });
    expect(trashRequests(target)).toHaveLength(0);
  });

  test("target verification failure means the source asset is not trashed", async () => {
    const content = bytes("bad checksum");
    const asset = mediaAsset("a1", content);
    const source = fake({ assets: [asset], originals: { a1: content } });
    const target = fake({ uploadChecksumMismatch: [asset.originalFileName] });

    const result = await runMove(options(source, target));

    expect(result.assets[0]?.status).toBe("failed");
    expect(result.summary).toMatchObject({ trashed: 0, failed: 1 });
    expect(asset.isTrashed).toBe(false);
    expect(trashRequests(source)).toHaveLength(0);
  });

  test("metadata sync failure means the source asset is not trashed", async () => {
    const content = bytes("metadata fails");
    const asset = mediaAsset("a1", content, "IMAGE", { isFavorite: true });
    const targetAsset = mediaAsset("t1", content, "IMAGE", { isFavorite: false, ownerId: "u-1" });
    const source = fake({ assets: [asset], originals: { a1: content } });
    const target = fake({ assets: [targetAsset], updateFailures: ["t1"] });

    const result = await runMove(options(source, target, { metadataSync: true }));

    expect(result.assets[0]).toMatchObject({ status: "metadata-failed", metadataStatus: "failed", copyStatus: "already-present" });
    expect(asset.isTrashed).toBe(false);
    expect(trashRequests(source)).toHaveLength(0);
  });

  test("successful metadata sync allows trashing", async () => {
    const content = bytes("metadata ok");
    const asset = mediaAsset("a1", content, "IMAGE", { isFavorite: true });
    const targetAsset = mediaAsset("t1", content, "IMAGE", { isFavorite: false });
    const source = fake({ assets: [asset], originals: { a1: content } });
    const target = fake({ assets: [targetAsset] });

    const result = await runMove(options(source, target, { metadataSync: true }));

    expect(result.assets[0]).toMatchObject({ status: "trashed", metadataStatus: "synced" });
    expect(targetAsset.isFavorite).toBe(true);
    expect(asset.isTrashed).toBe(true);
  });

  test("asset only in target trash is reported and never trashed on the source", async () => {
    const content = bytes("in target trash");
    const asset = mediaAsset("a1", content);
    const trashed = mediaAsset("t1", content, "IMAGE", { isTrashed: true });
    const source = fake({ assets: [asset], originals: { a1: content } });
    const target = fake({ assets: [trashed] });

    const result = await runMove(options(source, target));

    expect(result.assets[0]).toMatchObject({ status: "in-target-trash", trashedIds: [] });
    expect(result.summary).toMatchObject({ inTargetTrash: 1, trashed: 0 });
    expect(asset.isTrashed).toBe(false);
    expect(target.uploadedMedia).toHaveLength(0);
    expect(trashRequests(source)).toHaveLength(0);
  });

  test("rerun after a half-done move trashes already-present verified assets and is idempotent", async () => {
    const content = bytes("half done");
    const asset = mediaAsset("a1", content);
    const present = mediaAsset("t1", content);
    const source = fake({ assets: [asset], originals: { a1: content } });
    const target = fake({ assets: [present] });

    const first = await runMove(options(source, target));
    expect(first.assets[0]).toMatchObject({ status: "trashed", copyStatus: "already-present" });
    expect(target.uploadedMedia).toHaveLength(0);

    // The trashed source asset is excluded from the next plan, so nothing more happens.
    const second = await runMove(options(source, target));
    expect(second.assets).toHaveLength(0);
    expect(trashRequests(source)).toHaveLength(1);
  });

  test("cancellation never trashes unverified or unfinished assets", async () => {
    const controller = new AbortController();
    const one = bytes("one");
    const two = bytes("two");
    const first = mediaAsset("a1", one);
    const second = mediaAsset("a2", two);
    const source = fake({
      assets: [first, second],
      originals: { a1: one, a2: two },
      onDownload: (id) => {
        if (id === "a2") controller.abort();
      },
    });
    const target = fake();

    const result = await runMove(options(source, target, { signal: controller.signal }));

    expect(result.assets.map((asset) => asset.status)).toEqual(["cancelled", "cancelled"]);
    expect(result.summary).toMatchObject({ trashed: 0, cancelled: 2 });
    expect(first.isTrashed).toBe(false);
    expect(second.isTrashed).toBe(false);
    expect(trashRequests(source)).toHaveLength(0);
  });

  test("a per-asset failure does not stop other assets from being moved", async () => {
    const bad = mediaAsset("bad", bytes("bad"));
    const good = mediaAsset("good", bytes("good"));
    const source = fake({ assets: [bad, good], originals: { bad: bytes("bad"), good: bytes("good") } });
    const target = fake({ uploadFailures: [bad.originalFileName] });

    const result = await runMove(options(source, target));

    expect(result.assets.map((asset) => asset.status)).toEqual(["failed", "trashed"]);
    expect(bad.isTrashed).toBe(false);
    expect(good.isTrashed).toBe(true);
  });

  test("a trash request failure is reported per asset and continues", async () => {
    const a = mediaAsset("a", bytes("a"));
    const b = mediaAsset("b", bytes("b"));
    const source = fake({ assets: [a, b], originals: { a: bytes("a"), b: bytes("b") }, trashFailures: ["a"] });
    const target = fake();

    const result = await runMove(options(source, target));

    expect(result.assets.map((asset) => asset.status)).toEqual(["trash-failed", "trashed"]);
    expect(result.summary).toMatchObject({ trashFailed: 1, trashed: 1 });
  });

  test("Live Photo components are trashed together only when both are verified", async () => {
    const photoBytes = bytes("live image");
    const videoBytes = bytes("live video");
    const photo = mediaAsset("p", photoBytes, "IMAGE", { livePhotoVideoId: "v" });
    const video = mediaAsset("v", videoBytes, "VIDEO");
    const source = fake({ assets: [photo, video], originals: { p: photoBytes, v: videoBytes } });
    const target = fake();

    const result = await runMove(options(source, target));

    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.status).toBe("trashed");
    expect(result.assets[0]?.trashedIds.sort()).toEqual(["p", "v"]);
    expect(photo.isTrashed && video.isTrashed).toBe(true);
    expect(trashRequests(source)).toHaveLength(1);
  });

  test("a failing Live Photo video leaves both components on the source", async () => {
    const photoBytes = bytes("live image 2");
    const videoBytes = bytes("live video 2");
    const photo = mediaAsset("p", photoBytes, "IMAGE", { livePhotoVideoId: "v" });
    const video = mediaAsset("v", videoBytes, "VIDEO");
    const source = fake({ assets: [photo, video], originals: { p: photoBytes, v: videoBytes } });
    const target = fake({ uploadFailures: [video.originalFileName] });

    const result = await runMove(options(source, target));

    expect(result.assets[0]?.status).toBe("failed");
    expect(photo.isTrashed || video.isTrashed).toBe(false);
    expect(trashRequests(source)).toHaveLength(0);
  });

  test("dry run changes nothing on either server", async () => {
    const content = bytes("dry");
    const asset = mediaAsset("a1", content);
    const source = fake({ assets: [asset], originals: { a1: content } });
    const target = fake();

    const result = await moveAssets(options(source, target, { dryRun: true }));

    expect(result.kind).toBe("transfer-preview");
    if (result.kind === "transfer-preview") {
      expect(result.operation).toBe("move");
      expect(result.summary.wouldTrashAfterSuccessfulTransfer).toBe(1);
    }
    expect(asset.isTrashed).toBe(false);
    for (const server of [source, target]) {
      expect(server.requests.filter((r) => !["GET", "POST"].includes(r.method) || (r.method === "POST" && r.path !== "/api/search/metadata"))).toEqual([]);
    }
    expect(target.uploadedMedia).toHaveLength(0);
  });

  test("refuses the same server and user", async () => {
    const content = bytes("same");
    const asset = mediaAsset("a1", content);
    const server = fake({ assets: [asset] });

    await expect(moveAssets(options(server, server))).rejects.toThrow("same server and user");
    expect(asset.isTrashed).toBe(false);
    expect(trashRequests(server)).toHaveLength(0);
  });

  test("never sends a force delete or any request other than a non-forced trash", async () => {
    const content = bytes("force");
    const asset = mediaAsset("a1", content);
    const source = fake({ assets: [asset], originals: { a1: content } });
    const target = fake();

    await runMove(options(source, target));

    for (const request of trashRequests(source)) {
      expect((request.body as { force?: boolean }).force).not.toBe(true);
      expect(request.path).toBe("/api/assets");
    }
    expect(source.requests.some((r) => r.method === "DELETE" && (r.body as { force?: boolean })?.force === true)).toBe(false);
    expect(source.requests.some((r) => r.method === "DELETE" && r.path !== "/api/assets")).toBe(false);
  });

  test("source key without asset.delete cannot move", async () => {
    const content = bytes("perm");
    const asset = mediaAsset("a1", content);
    const source = fake({
      assets: [asset],
      originals: { a1: content },
      permissions: ["user.read", "asset.read", "asset.view", "asset.download"],
    });
    const target = fake();

    await expect(moveAssets(options(source, target))).rejects.toThrow();
    expect(asset.isTrashed).toBe(false);
    expect(target.uploadedMedia).toHaveLength(0);
  });
});

describe("moveAssets cancelled during the final target verification", () => {
  /** How many checksum searches the target answers when nothing is cancelled; the last ones are the final verification. */
  async function targetChecksumSearches(): Promise<number> {
    const one = bytes("one");
    const source = fake({ assets: [mediaAsset("a1", one)], originals: { a1: one } });
    let calls = 0;
    const target = fake({ onMetadataSearch: (checksumValue) => { if (checksumValue) calls++; } });
    await runMove(options(source, target));
    return calls;
  }

  for (const [name, fromEnd] of [["its first request", 1], ["its last request", 0]] as const) {
    test(`a cancel on ${name} does not trash the verified asset`, async () => {
      const total = await targetChecksumSearches();
      expect(total).toBeGreaterThanOrEqual(2);
      const controller = new AbortController();
      const one = bytes("one");
      const a1 = mediaAsset("a1", one);
      const source = fake({ assets: [a1], originals: { a1: one } });
      let calls = 0;
      const target = fake({
        onMetadataSearch: (checksumValue) => {
          if (!checksumValue) return;
          calls++;
          if (calls === total - fromEnd) controller.abort();
        },
      });

      const result = await runMove(options(source, target, { signal: controller.signal }));

      expect(result.assets.map((asset) => asset.status)).toEqual(["cancelled"]);
      expect(result.assets[0]!.reason).toMatch(/cancelled/i);
      expect(result.summary).toMatchObject({ trashed: 0, cancelled: 1, failed: 0 });
      expect(a1.isTrashed).toBe(false);
      expect(trashRequests(source)).toHaveLength(0);
    });
  }
});
