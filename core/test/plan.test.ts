import { afterEach, describe, expect, test } from "bun:test";
import { planTransfer, TransferPlanError, type TransferPlanOptions } from "../src/plan.ts";
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

function asset(
  id: string,
  overrides: Partial<FakeAsset> = {},
): FakeAsset {
  return {
    id,
    checksum: `checksum-${id}`,
    ownerId: "u-1",
    originalFileName: `${id}.jpg`,
    type: "IMAGE",
    visibility: "timeline",
    isTrashed: false,
    fileCreatedAt: "2026-05-10T12:00:00.000Z",
    exifInfo: { fileSizeInByte: 10, dateTimeOriginal: "2026-05-10T12:00:00.000Z" },
    ...overrides,
  };
}

function options(source: ReturnType<typeof fake>, target: ReturnType<typeof fake>, overrides: Partial<TransferPlanOptions> = {}) {
  return {
    source: { alias: "source", apiUrl: source.url, apiKey: source.apiKey },
    target: { alias: "target", apiUrl: target.url, apiKey: target.apiKey },
    operation: "copy" as const,
    ...overrides,
  };
}

describe("planTransfer", () => {
  test("paginates own timeline and archived assets, excludes ineligible source assets, and detects target trash", async () => {
    const source = fake({
      pageSize: 1,
      assets: [
        asset("present"),
        asset("trashed-target", { visibility: "archive" }),
        asset("partner", { ownerId: "someone-else" }),
        asset("hidden", { visibility: "hidden" }),
        asset("locked", { visibility: "locked" }),
        asset("trashed-source", { isTrashed: true }),
      ],
    });
    const target = fake({
      version: { major: 3, minor: 3, patch: 0 },
      pageSize: 1,
      assets: [
        asset("target-present", { checksum: "checksum-present", ownerId: "target-user" }),
        asset("target-trash", { checksum: "checksum-trashed-target", ownerId: "target-user", isTrashed: true }),
      ],
    });

    const plan = await planTransfer(options(source, target, { operation: "move" }));

    expect(plan.kind).toBe("transfer-preview");
    expect(plan.assets.map((item) => item.id)).toEqual(["present", "trashed-target"]);
    expect(plan.assets.map((item) => item.status)).toEqual(["already-present", "in-target-trash"]);
    expect(plan.summary).toMatchObject({
      assetsFound: 2,
      alreadyPresent: 1,
      inTargetTrash: 1,
      wouldTransfer: 0,
      failed: 0,
      wouldTrashAfterSuccessfulTransfer: 1,
    });
    expect(plan.events.some((event) => event.type === "summary")).toBe(true);
    expect(plan.warnings.join(" ")).toContain("Metadata changes are not compared");
    expect(plan.warnings.join(" ")).toContain("source v3.3.3, target v3.3.0");
    expect(source.requests.some((request) => request.body && (request.body as { cursor?: string }).cursor)).toBe(true);
    // Trash state is stated in the filter; Immich v3.3.5 rejects the deprecated withDeleted flag next to a filter.
    type SearchBody = { withDeleted?: boolean; filter?: { trashedAt?: { eq?: null; ne?: null } } };
    const searchBodies = [...source.requests, ...target.requests].map((request) => request.body as SearchBody | undefined);
    expect(searchBodies.some((body) => body?.filter?.trashedAt?.ne === null)).toBe(true);
    expect(searchBodies.every((body) => body?.withDeleted === undefined)).toBe(true);
    expect([...source.requests, ...target.requests].every((request) =>
      (request.method === "POST" && request.path === "/api/search/metadata") ||
      (request.method === "GET" && /^\/api\/assets\/[^/]+$/.test(request.path)),
    )).toBe(true);
  });

  test("photos-only date-range preview includes and classifies a Live Photo companion", async () => {
    const photo = asset("live-photo", {
      livePhotoVideoId: "live-video",
      exifInfo: { fileSizeInByte: 12, dateTimeOriginal: "2026-05-12T12:00:00.000Z" },
    });
    const video = asset("live-video", {
      originalFileName: "live-photo.mov",
      type: "VIDEO",
      exifInfo: { fileSizeInByte: 18, dateTimeOriginal: "2026-05-12T12:00:00.000Z" },
    });
    const source = fake({ assets: [photo, video, asset("outside", {
      exifInfo: { fileSizeInByte: 30, dateTimeOriginal: "2025-01-01T00:00:00.000Z" },
    }), asset("standalone-video", { type: "VIDEO" })] });
    const target = fake({ assets: [asset("target-photo", {
      checksum: photo.checksum,
      ownerId: "target-user",
    })] });

    const plan = await planTransfer(options(source, target, {
      kind: "photos",
      range: { from: "2026-05-01T00:00:00.000Z", to: "2026-05-31T23:59:59.999Z" },
    }));

    expect(plan.assets).toHaveLength(1);
    const plannedPhoto = plan.assets[0]!;
    expect(plannedPhoto).toMatchObject({ id: "live-photo", status: "would-transfer" });
    expect(plannedPhoto.components.map((component) => String(component.type))).toEqual(["IMAGE", "VIDEO"]);
    expect(plannedPhoto.components.map((component) => component.status)).toEqual([
      "already-present",
      "would-transfer",
    ]);
    expect(plan.summary).toMatchObject({ assetsFound: 1, wouldTransfer: 1, bytesToTransfer: 18 });
    expect(source.requests.some((request) => request.method === "GET" && request.path.endsWith("/live-video"))).toBe(true);
    const searches = source.requests.filter((request) => request.path === "/api/search/metadata");
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((request) => {
      const filter = (request.body as { filter?: { type?: { eq?: string }; takenAt?: { gte?: string; lte?: string } } }).filter;
      return filter?.type?.eq === "IMAGE" &&
        filter.takenAt?.gte === "2026-05-01T00:00:00.000Z" &&
        filter.takenAt?.lte === "2026-05-31T23:59:59.999Z";
    })).toBe(true);
  });

  test("a rejected source search reports the server's validation message", async () => {
    const source = fake({ rejectSearchWith: "filter.takenAt must be a valid date" });
    const target = fake();

    await expect(planTransfer(options(source, target))).rejects.toThrow(
      "Source asset discovery failed for source (HTTP 400: Validation failed [{\"path\":[\"filter\"],\"message\":\"filter.takenAt must be a valid date\"}]).",
    );
  });

  test("plain dates are expanded to UTC day boundaries and either end may be left out", async () => {
    const taken = (iso: string) => ({ exifInfo: { dateTimeOriginal: iso, fileSizeInByte: 1 } });
    const source = fake({
      assets: [
        asset("before", taken("2026-04-30T23:59:59.000Z")),
        asset("first-day", taken("2026-05-01T00:00:00.000Z")),
        asset("last-day", taken("2026-05-31T23:59:59.000Z")),
        asset("after", taken("2026-06-01T00:00:00.000Z")),
      ],
    });
    const target = fake();
    const ids = async (range: TransferPlanOptions["range"]) =>
      (await planTransfer(options(source, target, { range }))).assets.map((item) => item.id).sort();

    expect(await ids({ from: "2026-05-01", to: "2026-05-31" })).toEqual(["first-day", "last-day"]);
    expect(await ids({ from: "2026-05-01" })).toEqual(["after", "first-day", "last-day"]);
    expect(await ids({ to: "2026-05-01" })).toEqual(["before", "first-day"]);
    expect(await ids({ from: "2026-05-01T00:00:00+00:00", to: "2026-05-31T23:59:59.999Z" })).toEqual(["first-day", "last-day"]);
  });

  test("an empty or reversed date range is refused", async () => {
    const source = fake();
    const target = fake();

    await expect(planTransfer(options(source, target, { range: {} }))).rejects.toThrow("needs a start date, an end date, or both");
    await expect(planTransfer(options(source, target, { range: { from: "2026-06-01", to: "2026-05-01" } }))).rejects.toThrow("must not be after");
    await expect(planTransfer(options(source, target, { range: { from: "nope" } }))).rejects.toThrow("valid ISO date");
  });

  test("a target lookup failure is isolated to its asset and the preview continues", async () => {
    const source = fake({ assets: [asset("failure"), asset("success")] });
    const target = fake({ searchErrorChecksums: ["checksum-failure"] });

    const plan = await planTransfer(options(source, target));

    expect(plan.assets.map((item) => item.status)).toEqual(["failed", "would-transfer"]);
    expect(plan.summary).toMatchObject({ assetsFound: 2, failed: 1, wouldTransfer: 1 });
    expect(plan.events.some((event) => event.type === "asset" && event.status === "failed")).toBe(true);
  });

  test("an incomplete target response fails closed for that asset", async () => {
    const source = fake({ assets: [asset("incomplete")] });
    const target = fake({ incompleteSearchChecksums: ["checksum-incomplete"] });

    const plan = await planTransfer(options(source, target));

    expect(plan.assets[0]?.status).toBe("failed");
    expect(plan.summary).toMatchObject({ failed: 1, wouldTransfer: 0, bytesToTransfer: 0 });
  });

  test("a Live Photo with an unverifiable companion is not counted as transferable", async () => {
    const photo = asset("photo-with-missing-video", { livePhotoVideoId: "unavailable-video" });
    const source = fake({ assets: [photo], assetInfoFailures: ["unavailable-video"] });
    const target = fake();

    const plan = await planTransfer(options(source, target, { kind: "photos" }));

    expect(plan.assets[0]?.status).toBe("failed");
    expect(plan.summary).toMatchObject({ failed: 1, wouldTransfer: 0, bytesToTransfer: 0 });
  });

  test("refuses a same-server same-user transfer before searching assets", async () => {
    const server = fake();

    await expect(planTransfer({
      source: { alias: "left", apiUrl: server.url, apiKey: server.apiKey },
      target: { alias: "right", apiUrl: `${server.url}/`, apiKey: server.apiKey },
      operation: "copy",
    })).rejects.toBeInstanceOf(TransferPlanError);

    expect(server.requests).toHaveLength(0);
  });

  test("preflight role failure blocks discovery", async () => {
    const source = fake();
    const target = fake({ permissions: ["user.read", "asset.read"] });

    await expect(planTransfer(options(source, target))).rejects.toThrow("target copy");
    expect(source.requests).toHaveLength(0);
    expect(target.requests).toHaveLength(0);
  });

  test("move preflight requires source trash permission", async () => {
    const source = fake({ permissions: ["user.read", "asset.read", "asset.view", "asset.download"] });
    const target = fake();

    await expect(planTransfer(options(source, target, { operation: "move" }))).rejects.toThrow("asset.delete");
    expect(source.requests).toHaveLength(0);
    expect(target.requests).toHaveLength(0);
  });

  test("rejects credential-bearing API URLs before making requests", async () => {
    const source = fake();
    const target = fake();
    const request = options(source, target);
    request.source.apiUrl = "https://name:secret@example.com/api";

    await expect(planTransfer(request)).rejects.toThrow("API URL");
    expect(source.requests).toHaveLength(0);
    expect(target.requests).toHaveLength(0);
  });
});
describe("planTransfer metadataSync option", () => {
  test("does not require the copy roles when planning for metadata sync", async () => {
    const source = fake({ permissions: ["user.read", "asset.read"] });
    const target = fake({ permissions: ["user.read", "asset.read", "asset.update"] });

    const plan = await planTransfer(options(source, target, { metadataSync: {} }));
    expect(plan.kind).toBe("transfer-preview");
  });

  test("refuses a target without asset.update, and does not accept asset.upload instead", async () => {
    const source = fake({ permissions: ["user.read", "asset.read"] });
    const target = fake({ permissions: ["user.read", "asset.read", "asset.upload"] });

    await expect(planTransfer(options(source, target, { metadataSync: {} }))).rejects.toThrow("asset.update");
    expect(source.requests).toHaveLength(0);
  });

  test("album and tag permissions are added only for enabled options", async () => {
    const source = fake({ permissions: ["user.read", "asset.read"] });
    const target = fake({ permissions: ["user.read", "asset.read", "asset.update"] });

    await expect(planTransfer(options(source, target, { metadataSync: { includeTags: true } }))).rejects.toThrow("tag.asset");
    await expect(planTransfer(options(source, target, { metadataSync: { includeAlbums: true } }))).rejects.toThrow("album.read");
  });
});
