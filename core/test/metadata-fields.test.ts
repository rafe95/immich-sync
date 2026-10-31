import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { syncMetadataFields } from "../src/metadata-fields.ts";
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

function checksum(value = "matching-original"): string {
  return createHash("sha1").update(value).digest("base64");
}

function asset(id: string, overrides: Partial<FakeAsset> = {}): FakeAsset {
  const { exifInfo, ...otherOverrides } = overrides;
  return {
    id,
    checksum: checksum(),
    ownerId: "u-1",
    originalFileName: `${id}.jpg`,
    type: "IMAGE",
    visibility: "timeline",
    isTrashed: false,
    isFavorite: false,
    fileCreatedAt: "2024-01-01T00:00:00.000Z",
    ...otherOverrides,
    exifInfo: { ...exifInfo },
  };
}

function options(source: ReturnType<typeof fake>, target: ReturnType<typeof fake>, assetIds: string[], overrides = {}) {
  return {
    source: { alias: "source", apiUrl: source.url, apiKey: source.apiKey },
    target: { alias: "target", apiUrl: target.url, apiKey: target.apiKey },
    assetIds,
    ...overrides,
  };
}

function updateRequests(server: ReturnType<typeof fake>) {
  return server.requests.filter((request) => request.method === "PUT" && /^\/api\/assets\/[^/]+$/.test(request.path));
}

describe("syncMetadataFields", () => {
  test("updates supported fields on an owned, checksum-matched target and verifies them", async () => {
    const sourceAsset = asset("source-1", {
      isFavorite: false,
      visibility: "archive",
      exifInfo: { description: "source description", rating: 0, latitude: 0, longitude: 0 },
    });
    const targetAsset = asset("target-1", {
      isFavorite: true,
      visibility: "timeline",
      exifInfo: { description: "target description", rating: 5, latitude: 45, longitude: 12 },
    });
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ assets: [targetAsset] });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(result.assets[0]).toMatchObject({
      id: sourceAsset.id,
      status: "updated",
      targetId: targetAsset.id,
      changedFields: ["isFavorite", "visibility", "description", "rating", "location"],
    });
    expect(result.summary).toMatchObject({ assetsSelected: 1, updated: 1, failed: 0 });
    expect(updateRequests(target)).toHaveLength(1);
    expect(updateRequests(target)[0]?.body).toEqual({
      isFavorite: false,
      visibility: "archive",
      description: "source description",
      rating: 0,
      latitude: 0,
      longitude: 0,
    });
    expect(targetAsset).toMatchObject({
      isFavorite: false,
      visibility: "archive",
      exifInfo: { description: "source description", rating: 0, latitude: 0, longitude: 0 },
    });
    expect(sourceAsset).toMatchObject({
      isFavorite: false,
      visibility: "archive",
      exifInfo: { description: "source description", rating: 0, latitude: 0, longitude: 0 },
    });
    expect(source.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  test("dry runs report differences without sending updates", async () => {
    const sourceAsset = asset("source-dry", { isFavorite: false, exifInfo: { description: "source" } });
    const targetAsset = asset("target-dry", { isFavorite: true, exifInfo: { description: "target" } });
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ assets: [targetAsset] });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id], { dryRun: true }));

    expect(result.assets[0]).toMatchObject({ status: "would-update", changedFields: ["isFavorite", "description"] });
    expect(result.summary.wouldUpdate).toBe(1);
    expect(updateRequests(target)).toHaveLength(0);
    expect(targetAsset).toMatchObject({ isFavorite: true, exifInfo: { description: "target" } });
  });

  test("false favorites are explicit while null, empty, and incomplete source metadata preserve target values", async () => {
    const sourceAsset = asset("source-empty", {
      isFavorite: false,
      exifInfo: { description: "  ", rating: null, latitude: 0, longitude: null },
    });
    const targetAsset = asset("target-empty", {
      isFavorite: true,
      exifInfo: { description: "target description", rating: 4, latitude: 10, longitude: 20 },
    });
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ assets: [targetAsset] });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(result.assets[0]).toMatchObject({ status: "updated", changedFields: ["isFavorite"] });
    expect(updateRequests(target)[0]?.body).toEqual({ isFavorite: false });
    expect(targetAsset).toMatchObject({
      isFavorite: false,
      exifInfo: { description: "target description", rating: 4, latitude: 10, longitude: 20 },
    });
  });

  test("reruns are idempotent and update only once", async () => {
    const sourceAsset = asset("source-repeat", { exifInfo: { description: "kept" } });
    const targetAsset = asset("target-repeat", { exifInfo: { description: "old" } });
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ assets: [targetAsset] });

    const first = await syncMetadataFields(options(source, target, [sourceAsset.id]));
    const second = await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(first.assets[0]?.status).toBe("updated");
    expect(second.assets[0]?.status).toBe("already-synced");
    expect(updateRequests(target)).toHaveLength(1);
  });

  test("requires only source read and target read/update permissions before asset requests", async () => {
    const source = fake({ permissions: ["user.read", "asset.read"] });
    const target = fake({ permissions: ["user.read", "asset.read"] });

    await expect(syncMetadataFields(options(source, target, ["source-1"]))).rejects.toThrow("asset.update");
    expect([...source.requests, ...target.requests].some((request) => request.path === "/api/search/metadata" || request.path === "/api/assets/source-1")).toBe(false);
    expect(updateRequests(target)).toHaveLength(0);
  });

  test("refuses the same normalized server and user", async () => {
    const server = fake();
    const same = {
      source: { alias: "source", apiUrl: server.url, apiKey: server.apiKey },
      target: { alias: "target", apiUrl: `${server.url}/`, apiKey: server.apiKey },
      assetIds: ["source-1"],
    };

    await expect(syncMetadataFields(same)).rejects.toThrow("different servers or users");
    expect(server.requests.some((request) => request.path === "/api/search/metadata")).toBe(false);
  });

  test("fails closed for missing, trashed, ambiguous, foreign, or hidden target matches", async () => {
    const sourceAsset = asset("source-match");
    const source = fake({ assets: [sourceAsset] });
    const scenarios: Array<{ name: string; assets: FakeAsset[]; expected: string }> = [
      { name: "missing", assets: [], expected: "No target asset" },
      { name: "trashed", assets: [asset("target-trash", { isTrashed: true })], expected: "in-target-trash" },
      { name: "ambiguous", assets: [asset("target-a"), asset("target-b")], expected: "Multiple target assets" },
      { name: "foreign", assets: [asset("target-foreign", { ownerId: "other-user" })], expected: "not owned" },
      { name: "hidden", assets: [asset("target-hidden", { visibility: "hidden" })], expected: "Hidden or locked" },
    ];

    for (const scenario of scenarios) {
      const target = fake({ assets: scenario.assets });
      const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));
      if (scenario.expected === "in-target-trash") {
        expect(result.assets[0]?.status, scenario.name).toBe("in-target-trash");
      } else {
        expect(result.assets[0]?.status, scenario.name).toBe("failed");
        expect(result.assets[0]?.message, scenario.name).toContain(scenario.expected);
      }
      expect(updateRequests(target), scenario.name).toHaveLength(0);
      target.stop();
      stops = stops.filter((stop) => stop !== target.stop);
    }
  });

  test("fails closed when target checksum search is incomplete", async () => {
    const sourceAsset = asset("source-incomplete");
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ incompleteSearchChecksums: [sourceAsset.checksum] });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(result.assets[0]).toMatchObject({ status: "failed", message: "Immich asset search ended before returning all matching assets." });
    expect(updateRequests(target)).toHaveLength(0);
  });

  test("rejects foreign, trashed, hidden, and locked source assets without changing targets", async () => {
    const cases: FakeAsset[] = [
      asset("foreign-source", { ownerId: "someone-else" }),
      asset("trashed-source", { isTrashed: true }),
      asset("hidden-source", { visibility: "hidden" }),
      asset("locked-source", { visibility: "locked" }),
    ];
    const source = fake({ assets: cases });
    const target = fake({ assets: cases.map((item) => asset(`target-${item.id}`)) });

    const result = await syncMetadataFields(options(source, target, cases.map((item) => item.id)));

    expect(result.summary.failed).toBe(cases.length);
    expect(updateRequests(target)).toHaveLength(0);
    expect(target.requests.some((request) => request.path === "/api/search/metadata")).toBe(false);
  });

  test("continues after per-asset lookup and update failures", async () => {
    const first = asset("source-update-fails", { checksum: checksum("first"), exifInfo: { description: "new" } });
    const second = asset("source-lookup-fails", { checksum: checksum("second") });
    const third = asset("source-succeeds", { checksum: checksum("third"), exifInfo: { description: "new" } });
    const source = fake({ assets: [first, second, third], assetInfoFailures: [second.id] });
    const firstTarget = asset("target-update-fails", { checksum: checksum("first"), exifInfo: { description: "old" } });
    const secondTarget = asset("target-lookup-fails", { checksum: checksum("second") });
    const thirdTarget = asset("target-succeeds", { checksum: checksum("third"), exifInfo: { description: "old" } });
    const target = fake({ assets: [firstTarget, secondTarget, thirdTarget], updateFailures: [firstTarget.id] });

    const result = await syncMetadataFields(options(source, target, [first.id, second.id, third.id]));

    expect(result.assets.map((item) => item.status)).toEqual(["failed", "failed", "updated"]);
    expect(result.summary).toMatchObject({ failed: 2, updated: 1 });
    expect(updateRequests(target)).toHaveLength(2);
  });

  test("does not begin asset work when already cancelled", async () => {
    const sourceAsset = asset("source-cancel", { exifInfo: { description: "new" } });
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ assets: [asset("target-cancel", { exifInfo: { description: "old" } })] });
    const controller = new AbortController();
    controller.abort();

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id], { signal: controller.signal }));

    expect(result.assets[0]?.status).toBe("cancelled");
    expect(result.summary.cancelled).toBe(1);
    expect(source.requests.some((request) => request.method === "GET" && request.path === `/api/assets/${sourceAsset.id}`)).toBe(false);
    expect(updateRequests(target)).toHaveLength(0);
  });

  test("stops before updating when cancellation arrives during target discovery", async () => {
    const sourceAsset = asset("source-cancel-during-search", { exifInfo: { description: "new" } });
    const source = fake({ assets: [sourceAsset] });
    const controller = new AbortController();
    const target = fake({
      assets: [asset("target-cancel-during-search", { exifInfo: { description: "old" } })],
      onMetadataSearch: () => controller.abort(),
    });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id], { signal: controller.signal }));

    expect(result.assets[0]?.status).toBe("cancelled");
    expect(updateRequests(target)).toHaveLength(0);
  });

  test("rejects malformed IDs before making requests", async () => {
    const source = fake();
    const target = fake();

    await expect(syncMetadataFields(options(source, target, ["../asset"]))).rejects.toThrow("valid asset identifier");
    expect(source.requests).toHaveLength(0);
    expect(target.requests).toHaveLength(0);
  });
});
describe("syncMetadataFields date taken with time zone", () => {
  const taken = (iso: string, timeZone?: string) => ({ dateTimeOriginal: iso, ...(timeZone ? { timeZone } : {}) });

  test("syncs the instant and offset from an IANA source zone and verifies the target", async () => {
    const sourceAsset = asset("s-date", { exifInfo: taken("2024-07-01T08:00:00.000Z", "Europe/Berlin") });
    const targetAsset = asset("t-date", { exifInfo: taken("2024-07-01T09:00:00.000Z", "UTC") });
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ assets: [targetAsset] });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(result.assets[0]).toMatchObject({ status: "updated", changedFields: ["dateTimeOriginal"] });
    expect(updateRequests(target)[0]?.body).toEqual({ dateTimeOriginal: "2024-07-01T10:00:00.000+02:00" });
    expect(targetAsset.exifInfo).toMatchObject({ dateTimeOriginal: "2024-07-01T08:00:00.000Z", timeZone: "UTC+2" });

    const rerun = await syncMetadataFields(options(source, target, [sourceAsset.id]));
    expect(rerun.assets[0]?.status).toBe("already-synced");
  });

  test("updates only the zone when the instant already matches (fixed UTC offset form)", async () => {
    const sourceAsset = asset("s-tz", { exifInfo: taken("2024-01-01T12:00:00.000Z", "UTC-05:30") });
    const targetAsset = asset("t-tz", { exifInfo: taken("2024-01-01T12:00:00.000Z", "UTC") });
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ assets: [targetAsset] });

    await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(updateRequests(target)[0]?.body).toEqual({ dateTimeOriginal: "2024-01-01T06:30:00.000-05:30" });
    expect(targetAsset.exifInfo?.timeZone).toBe("UTC-5:30");
  });

  test("skips the date when the source has no resolvable time zone instead of guessing", async () => {
    const noZone = asset("s-nz", { exifInfo: taken("2024-07-01T08:00:00.000Z") });
    const badZone = asset("s-bz", { exifInfo: taken("2024-07-01T08:00:00.000Z", "Mars/Olympus") });
    const t1 = asset("t-nz", { exifInfo: taken("2020-01-01T00:00:00.000Z", "UTC") });
    const t2 = asset("t-bz", { exifInfo: taken("2020-01-01T00:00:00.000Z", "UTC") });
    t2.checksum = checksum("other");
    badZone.checksum = checksum("other");
    const source = fake({ assets: [noZone, badZone] });
    const target = fake({ assets: [t1, t2] });

    const result = await syncMetadataFields(options(source, target, [noZone.id, badZone.id]));

    expect(result.assets.map((item) => item.status)).toEqual(["already-synced", "already-synced"]);
    expect(updateRequests(target)).toHaveLength(0);
  });

  test("dry run does not mutate", async () => {
    const sourceAsset = asset("s-dry", { exifInfo: taken("2024-07-01T08:00:00.000Z", "UTC+2") });
    const targetAsset = asset("t-dry", { exifInfo: taken("2020-01-01T00:00:00.000Z", "UTC") });
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ assets: [targetAsset] });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id], { dryRun: true }));

    expect(result.assets[0]).toMatchObject({ status: "would-update", changedFields: ["dateTimeOriginal"] });
    expect(updateRequests(target)).toHaveLength(0);
    expect(targetAsset.exifInfo?.dateTimeOriginal).toBe("2020-01-01T00:00:00.000Z");
  });

  test("fails when the target does not reflect the requested date after the update", async () => {
    const sourceAsset = asset("s-ign", { exifInfo: taken("2024-07-01T08:00:00.000Z", "UTC+2") });
    const targetAsset = asset("t-ign", { exifInfo: taken("2020-01-01T00:00:00.000Z", "UTC") });
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ assets: [targetAsset], ignoreDateUpdates: true });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(result.assets[0]?.status).toBe("failed");
    expect(result.assets[0]?.message).toContain("did not match");
  });

  test("reports an update failure per asset", async () => {
    const sourceAsset = asset("s-fail", { exifInfo: taken("2024-07-01T08:00:00.000Z", "UTC+2") });
    const targetAsset = asset("t-fail", { exifInfo: taken("2020-01-01T00:00:00.000Z", "UTC") });
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ assets: [targetAsset], updateFailures: [targetAsset.id] });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(result.assets[0]).toMatchObject({ status: "failed", message: "HTTP 500: Asset update failed" });
  });
});
