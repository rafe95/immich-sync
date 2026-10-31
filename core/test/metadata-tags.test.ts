import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { syncMetadataFields } from "../src/metadata-fields.ts";
import { startFakeImmich, type FakeAsset, type FakeTag } from "./fake-immich.ts";

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

function asset(id: string, tags: FakeTag[] = [], checksumValue = "same"): FakeAsset {
  return {
    id,
    checksum: createHash("sha1").update(checksumValue).digest("base64"),
    ownerId: "u-1",
    originalFileName: `${id}.jpg`,
    type: "IMAGE",
    visibility: "timeline",
    isTrashed: false,
    isFavorite: false,
    fileCreatedAt: "2024-01-01T00:00:00.000Z",
    tags,
  };
}

const tag = (id: string, value: string): FakeTag => ({ id, name: value.split("/").pop() ?? value, value });

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
    includeTags: true,
    ...overrides,
  };
}

const requests = (server: ReturnType<typeof fake>, method: string, path: string) =>
  server.requests.filter((request) => request.method === method && request.path === path);

describe("syncMetadataFields tags", () => {
  test("attaches existing tags, creates missing ones, and preserves target-only tags", async () => {
    const sourceAsset = asset("s1", [tag("a", "Trip"), tag("b", "Family/Kids")]);
    const keep = tag("t-keep", "Keep");
    const existing = tag("t-trip", "Trip");
    const targetAsset = asset("t1", [keep]);
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ assets: [targetAsset], tags: [keep, existing] });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(result.assets[0]).toMatchObject({
      status: "updated",
      changedFields: ["tags"],
      changedTags: ["Trip", "Family/Kids"],
    });
    expect(requests(target, "PUT", "/api/tags")[0]?.body).toEqual({ tags: ["Family/Kids"] });
    expect(targetAsset.tags?.map((item) => item.value).sort()).toEqual(["Family/Kids", "Keep", "Trip"]);
    expect(requests(target, "GET", "/api/tags")).toHaveLength(1);
    expect(requests(target, "PUT", "/api/tags").length).toBe(1);
    expect(requests(target, "PUT", "/api/tags/assets")).toHaveLength(1);

    const rerun = await syncMetadataFields(options(source, target, [sourceAsset.id]));
    expect(rerun.assets[0]?.status).toBe("already-synced");
    expect(requests(target, "PUT", "/api/tags/assets")).toHaveLength(1);
  });

  test("is off by default and needs no tag permissions", async () => {
    const sourceAsset = asset("s2", [tag("a", "Trip")]);
    const targetAsset = asset("t2");
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ assets: [targetAsset], permissions: ["user.read", "asset.read", "asset.update"] });
    const settings = options(source, target, [sourceAsset.id]);
    delete (settings as { includeTags?: boolean }).includeTags;

    const result = await syncMetadataFields(settings);

    expect(result.assets[0]?.status).toBe("already-synced");
    expect(target.requests.some((request) => request.path.startsWith("/api/tags"))).toBe(false);
  });

  test("matches tags by exact value, not case-insensitively", async () => {
    const sourceAsset = asset("s3", [tag("a", "trip")]);
    const targetAsset = asset("t3", [tag("t-x", "Trip")]);
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ assets: [targetAsset], tags: [tag("t-x", "Trip")] });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(result.assets[0]).toMatchObject({ status: "updated", changedTags: ["trip"] });
    expect(requests(target, "PUT", "/api/tags")[0]?.body).toEqual({ tags: ["trip"] });
  });

  test("dry run reports tags without any write", async () => {
    const sourceAsset = asset("s4", [tag("a", "New")]);
    const targetAsset = asset("t4");
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ assets: [targetAsset] });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id], { dryRun: true }));

    expect(result.assets[0]).toMatchObject({ status: "would-update", changedFields: ["tags"], changedTags: ["New"] });
    expect(target.requests.some((request) => request.method === "PUT")).toBe(false);
    expect(targetAsset.tags).toEqual([]);
  });

  test("requires target tag permissions before any asset request", async () => {
    for (const missing of ["tag.read", "tag.create", "tag.asset"]) {
      const granted = ["user.read", "asset.read", "asset.update", "tag.read", "tag.create", "tag.asset"]
        .filter((permission) => permission !== missing);
      const source = fake({ assets: [asset("s5", [tag("a", "X")])] });
      const target = fake({ assets: [asset("t5")], permissions: granted });

      await expect(syncMetadataFields(options(source, target, ["s5"]))).rejects.toThrow(missing);
      expect(source.requests.some((request) => request.path.startsWith("/api/assets"))).toBe(false);
      expect(target.requests.some((request) => request.path.startsWith("/api/assets"))).toBe(false);
    }
  });

  test("rejects a non-boolean includeTags", async () => {
    const source = fake({ assets: [asset("s6")] });
    const target = fake({ assets: [asset("t6")] });
    await expect(syncMetadataFields(options(source, target, ["s6"], { includeTags: 1 }))).rejects.toThrow("includeTags");
  });

  test("reports upsert, assignment, listing and verification failures per asset", async () => {
    const scenarios: Array<[string, Parameters<typeof startFakeImmich>[0], string]> = [
      ["upsert", { tagUpsertFailures: ["New"] }, "HTTP 500"],
      ["assign", { tagAssignFailures: ["t7"] }, "HTTP 500"],
      ["list", { tagListFailures: true }, "HTTP 500"],
      ["verify", { tagAssignNoOp: true }, "could not be verified"],
    ];
    for (const [name, targetOptions, message] of scenarios) {
      const sourceAsset = asset("s7", [tag("a", "New")]);
      const targetAsset = asset("t7");
      const source = fake({ assets: [sourceAsset] });
      const target = fake({ assets: [targetAsset], ...targetOptions });

      const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

      expect(result.assets[0]?.status, name).toBe("failed");
      expect(result.assets[0]?.message, name).toContain(message);
      expect(result.assets[0]?.changedTags, name).toEqual([]);
    }
  });

  test("a failure on one asset does not stop the next", async () => {
    const sources = [asset("s8a", [tag("a", "A")], "a"), asset("s8b", [tag("a", "A")], "b")];
    const targets = [asset("t8a", [], "a"), asset("t8b", [], "b")];
    const source = fake({ assets: sources });
    const target = fake({ assets: targets, tagAssignFailures: ["t8a"] });

    const result = await syncMetadataFields(options(source, target, ["s8a", "s8b"]));

    expect(result.assets.map((item) => item.status)).toEqual(["failed", "updated"]);
  });

  test("cancellation before tag mutation leaves the target untouched", async () => {
    const sourceAsset = asset("s9", [tag("a", "New")]);
    const targetAsset = asset("t9");
    const source = fake({ assets: [sourceAsset] });
    const controller = new AbortController();
    const target = fake({ assets: [targetAsset], onMetadataSearch: () => controller.abort() });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id], { signal: controller.signal }));

    expect(result.assets[0]?.status).toBe("cancelled");
    expect(target.requests.some((request) => request.method === "PUT")).toBe(false);
    expect(targetAsset.tags).toEqual([]);
  });

  test("an asset whose checksum match is in target trash is skipped without tag writes", async () => {
    const sourceAsset = asset("s10", [tag("a", "New")]);
    const targetAsset = { ...asset("t10"), isTrashed: true };
    const source = fake({ assets: [sourceAsset] });
    const target = fake({ assets: [targetAsset] });

    const result = await syncMetadataFields(options(source, target, [sourceAsset.id]));

    expect(result.assets[0]?.status).toBe("in-target-trash");
    expect(target.requests.some((request) => request.path.startsWith("/api/tags"))).toBe(false);
  });
});
