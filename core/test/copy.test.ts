import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { copyAssets, type CopyOptions, type CopyResult } from "../src/copy.ts";
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

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function checksum(content: Uint8Array): string {
  return createHash("sha1").update(content).digest("base64");
}

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
  overrides: Partial<CopyOptions> = {},
): CopyOptions {
  return {
    source: { alias: "source", apiUrl: source.url, apiKey: source.apiKey },
    target: { alias: "target", apiUrl: target.url, apiKey: target.apiKey },
    operation: "copy",
    metadataSync: false,
    ...overrides,
  };
}

async function runCopy(input: CopyOptions): Promise<CopyResult> {
  const result = await copyAssets(input);
  if (result.kind !== "copy-run") throw new Error("Expected an executing copy result.");
  return result;
}

describe("copyAssets", () => {
  test("streams original bytes and reports copied only after target checksum verification", async () => {
    const content = bytes("original media bytes across multiple chunks".repeat(2048));
    const sourceAsset = mediaAsset("source-image", content);
    const source = fake({ assets: [sourceAsset], originals: { [sourceAsset.id]: content } });
    const target = fake();

    const result = await runCopy(options(source, target));

    expect(result.assets[0]?.status).toBe("copied");
    expect(result.assets[0]?.components[0]).toMatchObject({ status: "copied", checksum: sourceAsset.checksum });
    expect(result.summary).toMatchObject({ assetsFound: 1, assetsCopied: 1, componentsCopied: 1, failed: 0 });
    expect(target.uploadedMedia).toHaveLength(1);
    expect(target.uploadedMedia[0]?.bytes).toEqual(content);
    const upload = target.requests.find((request) => request.method === "POST" && request.path === "/api/assets");
    expect(upload?.body).toMatchObject({ isFavorite: null, visibility: null });
    expect(target.requests.some((request) => request.method === "POST" && request.path === "/api/assets")).toBe(true);
    expect(source.requests.some((request) => request.method === "GET" && request.path.endsWith("/original"))).toBe(true);
    expect(result.events.at(-1)).toMatchObject({ type: "summary" });
    expect(result.warnings.join(" ")).toContain("Metadata changes are not compared or synchronized");
  });

  test("dry run returns the unchanged preview and makes no media requests or mutations", async () => {
    const content = bytes("dry-run");
    const sourceAsset = mediaAsset("dry-run", content);
    const source = fake({ assets: [sourceAsset], originals: { [sourceAsset.id]: content } });
    const target = fake();

    const result = await copyAssets(options(source, target, { dryRun: true }));

    expect(result.kind).toBe("transfer-preview");
    expect(target.requests.some((request) => request.method === "POST" && request.path === "/api/assets")).toBe(false);
    expect(source.requests.some((request) => request.path.endsWith("/original"))).toBe(false);
    expect(target.uploadedMedia).toHaveLength(0);
  });

  test("target preflight failure prevents discovery and upload", async () => {
    const content = bytes("preflight");
    const sourceAsset = mediaAsset("preflight", content);
    const source = fake({ assets: [sourceAsset], originals: { [sourceAsset.id]: content } });
    const target = fake({ permissions: ["user.read", "asset.read"] });

    await expect(copyAssets(options(source, target))).rejects.toThrow("target copy");

    expect(source.requests).toHaveLength(0);
    expect(target.requests.some((request) => request.method === "POST" && request.path === "/api/assets")).toBe(false);
    expect(target.uploadedMedia).toHaveLength(0);
  });

  test("fresh target checksum lookup failure prevents transfer", async () => {
    const content = bytes("lookup failure");
    const sourceAsset = mediaAsset("lookup-failure", content);
    const source = fake({ assets: [sourceAsset], originals: { [sourceAsset.id]: content } });
    const target = fake({ searchErrorChecksums: [sourceAsset.checksum] });

    const result = await runCopy(options(source, target));

    expect(result.assets[0]?.status).toBe("failed");
    expect(target.uploadedMedia).toHaveLength(0);
    expect(source.requests.some((request) => request.path.endsWith("/original"))).toBe(false);
  });

  test("is idempotent on rerun and skips an active target checksum", async () => {
    const content = bytes("same original");
    const sourceAsset = mediaAsset("repeat", content);
    const source = fake({ assets: [sourceAsset], originals: { [sourceAsset.id]: content } });
    const target = fake();

    const first = await runCopy(options(source, target));
    const second = await runCopy(options(source, target));

    expect(first.assets[0]?.status).toBe("copied");
    expect(second.assets[0]?.status).toBe("already-present");
    expect(target.uploadedMedia).toHaveLength(1);
  });

  test("does not re-upload a matching asset found only in target trash", async () => {
    const content = bytes("trashed original");
    const sourceAsset = mediaAsset("trashed", content);
    const trashedTarget = mediaAsset("target-trash", content, "IMAGE", { ownerId: "target-user", isTrashed: true });
    const source = fake({ assets: [sourceAsset], originals: { [sourceAsset.id]: content } });
    const target = fake({ assets: [trashedTarget] });

    const result = await runCopy(options(source, target));

    expect(result.assets[0]?.status).toBe("in-target-trash");
    expect(target.uploadedMedia).toHaveLength(0);
  });

  test("an active checksum match takes precedence when a duplicate also exists in target trash", async () => {
    const content = bytes("active and trashed");
    const sourceAsset = mediaAsset("duplicate", content);
    const active = mediaAsset("target-active", content, "IMAGE", { ownerId: "target-user" });
    const trashed = mediaAsset("target-trashed", content, "IMAGE", { ownerId: "target-user", isTrashed: true });
    const source = fake({ assets: [sourceAsset], originals: { [sourceAsset.id]: content } });
    const target = fake({ assets: [active, trashed] });

    const result = await runCopy(options(source, target));

    expect(result.assets[0]?.status).toBe("already-present");
    expect(target.uploadedMedia).toHaveLength(0);
  });

  test("checksum mismatch after upload is a failure, not a successful copy", async () => {
    const content = bytes("checksum mismatch");
    const sourceAsset = mediaAsset("mismatch", content);
    const source = fake({ assets: [sourceAsset], originals: { [sourceAsset.id]: content } });
    const target = fake({ uploadChecksumMismatch: [sourceAsset.originalFileName] });

    const result = await runCopy(options(source, target));

    expect(result.assets[0]?.status).toBe("failed");
    expect(result.summary).toMatchObject({ failed: 1, assetsCopied: 0 });
    expect(target.uploadedMedia).toHaveLength(1);
  });

  test("isolates an upload failure and continues with later assets", async () => {
    const badBytes = bytes("bad asset");
    const goodBytes = bytes("good asset");
    const bad = mediaAsset("bad", badBytes);
    const good = mediaAsset("good", goodBytes);
    const source = fake({ assets: [bad, good], originals: { bad: badBytes, good: goodBytes } });
    const target = fake({ uploadFailures: [bad.originalFileName] });

    const result = await runCopy(options(source, target));

    expect(result.assets.map((asset) => asset.status)).toEqual(["failed", "copied"]);
    expect(result.summary).toMatchObject({ failed: 1, assetsCopied: 1 });
    expect(target.uploadedMedia.map((media) => media.fileName)).toEqual([good.originalFileName]);
  });

  test("uploads a Live Photo video first and links the photo to its verified target video", async () => {
    const photoBytes = bytes("live photo image");
    const videoBytes = bytes("live photo video");
    const photo = mediaAsset("live-photo", photoBytes, "IMAGE", { livePhotoVideoId: "live-video" });
    const video = mediaAsset("live-video", videoBytes, "VIDEO");
    const source = fake({
      assets: [photo, video],
      originals: { [photo.id]: photoBytes, [video.id]: videoBytes },
    });
    const target = fake();

    const result = await runCopy(options(source, target));

    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.status).toBe("copied");
    expect(target.uploadedMedia.map((media) => media.fileName)).toEqual([video.originalFileName, photo.originalFileName]);
    const targetVideo = target.uploadedMedia.find((media) => media.fileName === video.originalFileName);
    const targetPhoto = target.uploadedMedia.find((media) => media.fileName === photo.originalFileName);
    expect(targetPhoto?.livePhotoVideoId).toBe(targetVideo?.id);
  });

  test("fails closed for an existing unpaired Live Photo image", async () => {
    const photoBytes = bytes("existing photo");
    const videoBytes = bytes("missing companion");
    const photo = mediaAsset("paired-photo", photoBytes, "IMAGE", { livePhotoVideoId: "paired-video" });
    const video = mediaAsset("paired-video", videoBytes, "VIDEO");
    const targetPhoto = mediaAsset("existing-target-photo", photoBytes, "IMAGE", { ownerId: "target-user" });
    const source = fake({
      assets: [photo, video],
      originals: { [photo.id]: photoBytes, [video.id]: videoBytes },
    });
    const target = fake({ assets: [targetPhoto] });

    const result = await runCopy(options(source, target));

    expect(result.assets[0]?.status).toBe("failed");
    expect(result.assets[0]?.message).toContain("unpaired Live Photo");
    expect(target.uploadedMedia).toHaveLength(0);
  });

  test("cancellation stops media requests and marks the asset cancelled", async () => {
    const controller = new AbortController();
    const content = bytes("cancel during download");
    const sourceAsset = mediaAsset("cancel", content);
    const source = fake({
      assets: [sourceAsset],
      originals: { [sourceAsset.id]: content },
      onDownload: () => controller.abort(),
    });
    const target = fake();

    const result = await runCopy(options(source, target, { signal: controller.signal }));

    expect(result.assets[0]?.status).toBe("cancelled");
    expect(result.summary.cancelled).toBe(1);
    expect(target.uploadedMedia).toHaveLength(0);
  });

  test("cancellation after verified Live Photo video retains it and cancels the photo", async () => {
    const controller = new AbortController();
    const photoBytes = bytes("photo before cancellation");
    const videoBytes = bytes("verified video before cancellation");
    const photo = mediaAsset("cancelled-photo", photoBytes, "IMAGE", { livePhotoVideoId: "cancelled-video" });
    const video = mediaAsset("cancelled-video", videoBytes, "VIDEO");
    const source = fake({
      assets: [photo, video],
      originals: { [photo.id]: photoBytes, [video.id]: videoBytes },
      onDownload: (assetId) => {
        if (assetId === photo.id) controller.abort();
      },
    });
    const target = fake();

    const result = await runCopy(options(source, target, { signal: controller.signal }));

    expect(result.assets[0]?.status).toBe("cancelled");
    expect(result.assets[0]?.components.map((component) => component.status)).toEqual(["cancelled", "copied"]);
    expect(result.summary).toMatchObject({ componentsCopied: 1, cancelled: 1 });
    expect(target.uploadedMedia.map((media) => media.fileName)).toEqual([video.originalFileName]);
  });

  test("download failure is isolated and does not create a target asset", async () => {
    const content = bytes("source unavailable");
    const sourceAsset = mediaAsset("download-failure", content);
    const source = fake({ assets: [sourceAsset], downloadFailures: [sourceAsset.id] });
    const target = fake();

    const result = await runCopy(options(source, target));

    expect(result.assets[0]?.status).toBe("failed");
    expect(target.uploadedMedia).toHaveLength(0);
  });
});