import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { syncMetadataFields } from "../src/metadata-fields.ts";
import { startFakeImmich, type FakeAlbum, type FakeAsset } from "./fake-immich.ts";

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

function checksum(value: string): string {
  return createHash("sha1").update(value).digest("base64");
}

function asset(id: string, checksumValue = "same"): FakeAsset {
  return {
    id,
    checksum: checksum(checksumValue),
    ownerId: "u-1",
    originalFileName: `${id}.jpg`,
    type: "IMAGE",
    visibility: "timeline",
    isTrashed: false,
    isFavorite: false,
    fileCreatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function album(
  id: string,
  albumName: string,
  assetIds: string[] = [],
  overrides: Partial<FakeAlbum> = {},
): FakeAlbum {
  return { id, albumName, ownerId: "u-1", assetIds, ...overrides };
}

function options(
  source: ReturnType<typeof fake>,
  target: ReturnType<typeof fake>,
  assetIds: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    source: { alias: "source", apiUrl: source.url, apiKey: source.apiKey },
    target: { alias: "target", apiUrl: target.url, apiKey: target.apiKey },
    assetIds,
    includeAlbums: true,
    createMissingAlbums: true,
    ...overrides,
  };
}

function albumRequests(server: ReturnType<typeof fake>, method: string, path: string) {
  return server.requests.filter((request) => request.method === method && request.path === path);
}

describe("syncMetadataFields album membership", () => {
  test("adds to an existing exact-name album and preserves target-only albums and settings", async () => {
    const sourceAsset = asset("source-1");
    const targetAsset = asset("target-1");
    const source = fake({
      assets: [sourceAsset],
      albums: [album("source-album", "Summer", [sourceAsset.id])],
    });
    const existing = album("target-existing", "Summer", [], {
      description: "target description",
      hasSharedLink: true,
      isActivityEnabled: true,
    });
    const targetOnly = album("target-only", "Keep me", [targetAsset.id]);
    const target = fake({ assets: [targetAsset], albums: [existing, targetOnly] });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(result.assets[0]).toMatchObject({ status: "updated", changedFields: ["albums"], changedAlbums: ["Summer"] });
    expect(result.summary).toMatchObject({ updated: 1, failed: 0 });
    expect(existing.assetIds).toEqual([targetAsset.id]);
    expect(existing).toMatchObject({ description: "target description", hasSharedLink: true, isActivityEnabled: true });
    expect(targetOnly.assetIds).toEqual([targetAsset.id]);
    expect(albumRequests(target, "POST", "/api/albums")).toHaveLength(0);
    expect(albumRequests(target, "PUT", "/api/albums/assets")[0]?.body).toEqual({
      albumIds: [existing.id],
      assetIds: [targetAsset.id],
    });
  });

  test("creates an exact-name album without sharing and verifies additive membership", async () => {
    const sourceAsset = asset("source-create");
    const targetAsset = asset("target-create");
    const source = fake({ assets: [sourceAsset], albums: [album("source-vacation", "Vacation", [sourceAsset.id])] });
    const targetAlbums: FakeAlbum[] = [];
    const target = fake({ assets: [targetAsset], albums: targetAlbums });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(result.assets[0]).toMatchObject({ status: "updated", changedFields: ["albums"], changedAlbums: ["Vacation"] });
    expect(albumRequests(target, "POST", "/api/albums")[0]?.body).toEqual({ albumName: "Vacation" });
    expect(albumRequests(target, "PUT", "/api/albums/assets")[0]?.body).toEqual({
      albumIds: ["album-1"],
      assetIds: [targetAsset.id],
    });
    expect(target.requests.some((request) => request.method === "POST" && request.path === "/api/albums" &&
      JSON.stringify(request.body).includes("albumUsers"))).toBe(false);
    expect(targetAlbums[0]).toMatchObject({ albumName: "Vacation", ownerId: "u-1", shared: false, assetIds: [targetAsset.id] });
    expect(albumRequests(target, "GET", "/api/albums").length).toBeGreaterThanOrEqual(3);
  });

  test("reuses the created album for multiple assets and converges on rerun", async () => {
    const sourceAssets = [asset("source-a", "a"), asset("source-b", "b")];
    const targetAssets = [asset("target-a", "a"), asset("target-b", "b")];
    const source = fake({
      assets: sourceAssets,
      albums: [album("source-shared", "Shared", sourceAssets.map((item) => item.id))],
    });
    const targetAlbums: FakeAlbum[] = [];
    const target = fake({ assets: targetAssets, albums: targetAlbums });

    const first = await syncMetadataFields(options(source, target, sourceAssets.map((item) => item.id)));
    const second = await syncMetadataFields(options(source, target, sourceAssets.map((item) => item.id)));

    expect(first.assets.map((item) => item.status)).toEqual(["updated", "updated"]);
    expect(second.assets.map((item) => item.status)).toEqual(["already-synced", "already-synced"]);
    expect(albumRequests(target, "POST", "/api/albums")).toHaveLength(1);
    expect(albumRequests(target, "PUT", "/api/albums/assets")).toHaveLength(2);
    expect(targetAlbums).toHaveLength(1);
    expect(targetAlbums[0]?.assetIds).toEqual(["target-a", "target-b"]);
  });

  test("dry run reports exact-case additions without creating albums or changing membership", async () => {
    const sourceAsset = asset("source-dry");
    const targetAsset = asset("target-dry");
    const source = fake({
      assets: [sourceAsset],
      returnForeignAlbumsForOwnedQueries: true,
      albums: [
        album("source-upper", "Trip", [sourceAsset.id]),
        album("source-lower", "trip", [sourceAsset.id]),
      ],
    });
    const target = fake({
      assets: [targetAsset],
      albums: [album("target-upper", "Trip", [targetAsset.id]), album("target-space", "Trip ")],
    });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id], { dryRun: true }));

    expect(result.assets[0]).toMatchObject({
      status: "would-update",
      changedFields: ["albums"],
      changedAlbums: ["trip"],
    });
    expect(albumRequests(target, "POST", "/api/albums")).toHaveLength(0);
    expect(albumRequests(target, "PUT", "/api/albums/assets")).toHaveLength(0);
    expect(target.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  test("rejects duplicate exact-name owned target albums before changing any asset metadata", async () => {
    const sourceAsset = asset("source-ambiguous");
    sourceAsset.isFavorite = true;
    const targetAsset = asset("target-ambiguous");
    const source = fake({
      assets: [sourceAsset],
      albums: [album("source-album", "Duplicate", [sourceAsset.id])],
    });
    const target = fake({
      assets: [targetAsset],
      albums: [album("target-a", "Duplicate"), album("target-b", "Duplicate")],
    });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(result.assets[0]).toMatchObject({ status: "failed", message: expect.stringContaining("ambiguous") });
    expect(targetAsset.isFavorite).toBe(false);
    expect(target.requests.some((request) => request.method === "PUT")).toBe(false);
    expect(albumRequests(target, "PUT", "/api/albums/assets")).toHaveLength(0);
  });

  test("excludes albums owned by other users and creates a private owned match", async () => {
    const sourceAsset = asset("source-owned");
    const targetAsset = asset("target-owned");
    const source = fake({
      assets: [sourceAsset],
      albums: [
        album("source-owned-album", "Family", [sourceAsset.id]),
        album("source-shared", "Not owned", [sourceAsset.id], { ownerId: "other-user", shared: true }),
      ],
    });
    const target = fake({
      assets: [targetAsset],
      returnForeignAlbumsForOwnedQueries: true,
      albums: [album("foreign-target", "Family", [], { ownerId: "other-user", shared: true })],
    });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(result.assets[0]).toMatchObject({ status: "updated", changedAlbums: ["Family"] });
    expect(albumRequests(target, "POST", "/api/albums")).toHaveLength(1);
    expect(target.requests.some((request) => request.method === "POST" && request.path === "/api/albums" &&
      JSON.stringify(request.body).includes("Not owned"))).toBe(false);
    expect(target.requests.some((request) => request.method === "POST" && request.path === "/api/albums/assets" &&
      JSON.stringify(request.body).includes("foreign-target"))).toBe(false);
  });

  test("fails closed on malformed album listing responses", async () => {
    const sourceAsset = asset("source-malformed");
    const targetAsset = asset("target-malformed");
    const source = fake({
      assets: [sourceAsset],
      albums: [album("source-album", "Album", [sourceAsset.id])],
    });
    const target = fake({ assets: [targetAsset], malformedAlbumResponses: true });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(result.assets[0]).toMatchObject({ status: "failed", message: expect.stringContaining("incomplete album") });
    expect(albumRequests(target, "POST", "/api/albums")).toHaveLength(0);
    expect(albumRequests(target, "PUT", "/api/albums/assets")).toHaveLength(0);
  });

  test("requires album permissions during preflight before reading selected assets", async () => {
    const source = fake({ permissions: ["user.read", "asset.read"] });
    const target = fake({ permissions: ["user.read", "asset.read", "asset.update", "album.read", "album.create"] });

    await expect(syncMetadataFields(options(source, target, ["source-no-album-permission"]))).rejects.toThrow("album.read");

    expect(source.requests.some((request) => request.path.startsWith("/api/assets/"))).toBe(false);
    expect(target.requests.some((request) => request.path.startsWith("/api/assets/"))).toBe(false);
    expect(target.requests.some((request) => request.path === "/api/albums")).toBe(false);
  });

  test("requires target album creation and membership permissions before asset requests", async () => {
    const requiredSource = ["user.read", "asset.read", "album.read"];
    const targetCases = [
      { permissions: ["user.read", "asset.read", "asset.update", "album.read", "albumAsset.create"], missing: "album.create" },
      { permissions: ["user.read", "asset.read", "asset.update", "album.read", "album.create"], missing: "albumAsset.create" },
    ];

    for (const scenario of targetCases) {
      const source = fake({ permissions: requiredSource });
      const target = fake({ permissions: scenario.permissions });

      await expect(syncMetadataFields(options(source, target, ["selected-asset"]))).rejects.toThrow(scenario.missing);

      expect(source.requests.some((request) => request.path.startsWith("/api/assets/") || request.path === "/api/search/metadata")).toBe(false);
      expect(target.requests.some((request) => request.path.startsWith("/api/assets/") || request.path === "/api/search/metadata")).toBe(false);
      expect(target.requests.some((request) => request.path === "/api/albums")).toBe(false);
      target.stop();
      stops = stops.filter((stop) => stop !== target.stop);
      source.stop();
      stops = stops.filter((stop) => stop !== source.stop);
    }
  });

  test("does not require album permissions or access album endpoints when the option is omitted", async () => {
    const sourceAsset = asset("source-default");
    const targetAsset = asset("target-default");
    const source = fake({
      permissions: ["user.read", "asset.read"],
      assets: [sourceAsset],
      albums: [album("source-album", "Source album", [sourceAsset.id])],
    });
    const target = fake({ permissions: ["user.read", "asset.read", "asset.update"], assets: [targetAsset] });
    const settings = options(source, target, [sourceAsset.id]);
    delete (settings as { includeAlbums?: boolean }).includeAlbums;
    delete (settings as { createMissingAlbums?: boolean }).createMissingAlbums;

    const result = await syncMetadataFields(settings);

    expect(result.assets[0]?.status).toBe("already-synced");
    expect([...source.requests, ...target.requests].some((request) => request.path === "/api/albums")).toBe(false);
  });

  test("reports album create, add, and membership verification failures without rolling back successful server changes", async () => {
    const scenarios = [
      { name: "create", configure: { albumCreateFailures: ["Album"] }, expected: "HTTP 500" },
      { name: "malformed-create", configure: { malformedAlbumCreateResponse: true }, expected: "did not match the requested name and owner" },
      { name: "add", configure: { albumAddFailures: ["album-1"] }, expected: "success" },
      {
        name: "verify",
        configure: { albumMembershipVerificationFailures: ["target-verify"] },
        expected: "HTTP 500",
      },
    ];

    for (const scenario of scenarios) {
      const sourceAsset = asset(`source-${scenario.name}`);
      const targetAsset = asset(`target-${scenario.name}`);
      const source = fake({ assets: [sourceAsset], albums: [album(`source-${scenario.name}-album`, "Album", [sourceAsset.id])] });
      const target = fake({
        assets: [targetAsset],
        ...scenario.configure,
      });

      const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

      expect(result.assets[0]?.status, scenario.name).toBe("failed");
      expect(result.assets[0]?.message, scenario.name).toContain(scenario.expected);
      if (scenario.name === "malformed-create") {
        expect(target.requests.some((request) => request.method === "PUT" && request.path === "/api/albums/assets"), scenario.name).toBe(false);
      }
      if (scenario.name === "verify") {
        expect(target.requests.some((request) => request.method === "PUT" && request.path === "/api/albums/assets"), scenario.name).toBe(true);
      }
      target.stop();
      stops = stops.filter((stop) => stop !== target.stop);
      source.stop();
      stops = stops.filter((stop) => stop !== source.stop);
    }
  });

  test("checks cancellation before the first album mutation", async () => {
    const sourceAsset = asset("source-cancel-album");
    const targetAsset = asset("target-cancel-album");
    const controller = new AbortController();
    const source = fake({ assets: [sourceAsset], albums: [album("source-album", "Album", [sourceAsset.id])] });
    const target = fake({
      assets: [targetAsset],
      onAlbumList: (assetId) => {
        if (assetId === targetAsset.id) controller.abort();
      },
    });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id], { signal: controller.signal }));

    expect(result.assets[0]?.status).toBe("cancelled");
    expect(albumRequests(target, "POST", "/api/albums")).toHaveLength(0);
    expect(albumRequests(target, "PUT", "/api/albums/assets")).toHaveLength(0);
  });

  test("checks cancellation between album creation and adding membership", async () => {
    const sourceAsset = asset("source-cancel-after-create");
    const targetAsset = asset("target-cancel-after-create");
    const controller = new AbortController();
    const source = fake({ assets: [sourceAsset], albums: [album("source-album", "Album", [sourceAsset.id])] });
    const target = fake({
      assets: [targetAsset],
      onAlbumCreate: () => controller.abort(),
    });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id], { signal: controller.signal }));

    expect(result.assets[0]).toMatchObject({ status: "cancelled", changedAlbums: [] });
    expect(albumRequests(target, "POST", "/api/albums")).toHaveLength(1);
    expect(albumRequests(target, "PUT", "/api/albums/assets")).toHaveLength(0);
  });

  test("does not create missing albums unless createMissingAlbums is set, and does not require album.create", async () => {
    const sourceAsset = asset("source-nocreate");
    const targetAsset = asset("target-nocreate");
    const source = fake({
      assets: [sourceAsset],
      albums: [album("sa", "Exists", [sourceAsset.id]), album("sb", "Missing", [sourceAsset.id])],
    });
    const existing = album("te", "Exists");
    const target = fake({
      permissions: ["user.read", "asset.read", "asset.update", "album.read", "albumAsset.create"],
      assets: [targetAsset],
      albums: [existing],
    });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id], { createMissingAlbums: false }));

    expect(result.assets[0]).toMatchObject({ status: "updated", changedAlbums: ["Exists"] });
    expect(result.assets[0]?.message).toContain("Missing");
    expect(albumRequests(target, "POST", "/api/albums")).toHaveLength(0);
    expect(existing.assetIds).toEqual([targetAsset.id]);
  });

  test("createMissingAlbums requires includeAlbums and boolean values", async () => {
    const source = fake({ assets: [asset("s")] });
    const target = fake({ assets: [asset("t")] });
    await expect(syncMetadataFields(options(source, target, ["s"], { includeAlbums: false })))
      .rejects.toThrow("createMissingAlbums requires includeAlbums");
    await expect(syncMetadataFields(options(source, target, ["s"], { createMissingAlbums: "yes" })))
      .rejects.toThrow("createMissingAlbums must be a boolean");
  });

  test("dry run with createMissingAlbums reports the creation but changes nothing", async () => {
    const sourceAsset = asset("source-dry-create");
    const targetAsset = asset("target-dry-create");
    const source = fake({ assets: [sourceAsset], albums: [album("sa", "New", [sourceAsset.id])] });
    const target = fake({ assets: [targetAsset] });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id], { dryRun: true }));

    expect(result.assets[0]).toMatchObject({ status: "would-update", changedAlbums: ["New"] });
    expect(target.requests.some((request) => request.method !== "GET" && request.method !== "POST" ||
      (request.method === "POST" && request.path === "/api/albums"))).toBe(false);
  });
});
