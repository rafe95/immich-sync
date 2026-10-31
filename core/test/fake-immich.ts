/** Minimal fake Immich server for tests. Grows with the engine (search, upload, trash, ...). */

import { createHash } from "node:crypto";

export type FakeImmichOptions = {
  version?: { major: number; minor: number; patch: number };
  apiKey?: string;
  permissions?: string[];
  user?: { id: string; email: string; name: string };
  assets?: FakeAsset[];
  searchErrorChecksums?: string[];
  /** Every metadata search answers 400 with this validation message (as a real server does for a rejected request). */
  rejectSearchWith?: string;
  incompleteSearchChecksums?: string[];
  assetInfoFailures?: string[];
  downloadFailures?: string[];
  uploadFailures?: string[];
  uploadChecksumMismatch?: string[];
  updateFailures?: string[];
  onMetadataSearch?: (checksum?: string) => void;
  albums?: FakeAlbum[];
  albumListFailures?: string[];
  malformedAlbumResponses?: boolean;
  malformedAlbumCreateResponse?: boolean;
  albumCreateFailures?: string[];
  albumAddFailures?: string[];
  albumMembershipVerificationFailures?: string[];
  onAlbumList?: (assetId?: string) => void;
  onAlbumCreate?: (albumName: string) => void;
  returnForeignAlbumsForOwnedQueries?: boolean;
  tags?: FakeTag[];
  tagListFailures?: boolean;
  tagUpsertFailures?: string[];
  tagAssignFailures?: string[];
  /** Assign calls report success but do not attach the tags. */
  tagAssignNoOp?: boolean;
  /** Date updates are accepted but ignored (to test verification). */
  ignoreDateUpdates?: boolean;
  originals?: Record<string, Uint8Array>;
  /** May return a promise; the request is held until it resolves (to test live events). */
  onDownload?: (assetId: string) => void | Promise<void>;
  /** Held until it resolves; called before an asset update (PUT /api/assets/:id) and before a trash request. */
  onAssetUpdate?: (assetId: string) => void | Promise<void>;
  onTrash?: (ids: string[]) => void | Promise<void>;
  trashFailures?: string[];
  /** Uploaded assets are returned without exifInfo by this many asset-info GETs (Infinity: never ready). */
  deferExifGets?: number;
  pageSize?: number;
};

export type FakeAlbum = {
  id: string;
  albumName: string;
  ownerId: string;
  assetIds: string[];
  shared?: boolean;
  description?: string;
  hasSharedLink?: boolean;
  isActivityEnabled?: boolean;
};

export type FakeTag = { id: string; name: string; value: string };

export type FakeAsset = {
  tags?: FakeTag[];
  id: string;
  checksum: string;
  ownerId: string;
  originalFileName: string;
  type: "IMAGE" | "VIDEO";
  visibility: "timeline" | "archive" | "hidden" | "locked";
  isTrashed: boolean;
  fileCreatedAt: string;
  livePhotoVideoId?: string | null;
  originalMimeType?: string;
  fileModifiedAt?: string;
  isFavorite?: boolean;
  duration?: number | null;
  exifInfo?: {
    fileSizeInByte?: number | null;
    dateTimeOriginal?: string | null;
    timeZone?: string | null;
    description?: string | null;
    rating?: number | null;
    latitude?: number | null;
    longitude?: number | null;
  };
};

const usedPorts = new Set<number>();

export function startFakeImmich(options: FakeImmichOptions = {}) {
  const version = options.version ?? { major: 3, minor: 3, patch: 3 };
  const apiKey = options.apiKey ?? "test-key";
  const permissions = options.permissions ?? ["all"];
  const user = options.user ?? { id: "u-1", email: "owner@example.com", name: "Owner" };
  const assets = options.assets ?? [];
  const albums = options.albums ?? [];
  const tags = options.tags ?? [];
  const addedAlbumAssetIds = new Set<string>();
  const deferredExif = new Map<string, number>();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const uploadedMedia: Array<{ id: string; fileName: string; bytes: Uint8Array; livePhotoVideoId: string | null }> = [];

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const unauthorized = () => json({ message: "Invalid API key", statusCode: 401 }, 401);
  const authed = (req: Request) => req.headers.get("x-api-key") === apiKey;
  const albumResponse = (album: FakeAlbum) => ({
    albumName: album.albumName,
    albumThumbnailAssetId: null,
    albumUsers: [{
      role: "owner",
      user: {
        id: album.ownerId,
        email: album.ownerId === user.id ? user.email : `${album.ownerId}@example.com`,
        name: album.ownerId === user.id ? user.name : "Other owner",
        isAdmin: false,
      },
    }],
    assetCount: album.assetIds.length,
    createdAt: "2024-01-01T00:00:00.000Z",
    description: album.description ?? "",
    hasSharedLink: album.hasSharedLink ?? false,
    id: album.id,
    isActivityEnabled: album.isActivityEnabled ?? false,
    shared: album.shared ?? false,
    updatedAt: "2024-01-01T00:00:00.000Z",
  });

  // Loopback only: a default 0.0.0.0 bind can succeed on a port another local program already holds on 127.0.0.1,
  // and requests would then reach that program (seen as intermittent 403/"Unable to connect" preflight failures).
  const start = () => Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/api/server/ping": () => json({ res: "pong" }),
      "/api/server/version": () => json({ ...version, prerelease: null }),
      "/api/users/me": (req) => (authed(req) ? json({ ...user, isAdmin: false }) : unauthorized()),
      "/api/api-keys/me": (req) =>
        authed(req)
          ? json({ id: "k-1", name: "immich-sync", permissions, createdAt: "", updatedAt: "" })
          : unauthorized(),
    },
    fetch: async (req) => {
      const url = new URL(req.url);
      const path = url.pathname;
      let body: unknown;
      if (req.method === "POST" && path === "/api/search/metadata") body = await req.json();
      const requestRecord: { method: string; path: string; body?: unknown } = { method: req.method, path, body };
      requests.push(requestRecord);

      if (!authed(req)) return unauthorized();

      if (req.method === "POST" && path === "/api/search/metadata" && options.rejectSearchWith) {
        return json({ message: "Validation failed", errors: [{ path: ["filter"], message: options.rejectSearchWith }], statusCode: 400 }, 400);
      }
      if (req.method === "POST" && path === "/api/search/metadata") {
        const search = body as {
          cursor?: string;
          size?: number;
          withDeleted?: boolean;
          filter?: {
            trashedAt?: { eq?: string | null; ne?: string | null };
            checksum?: { eq?: string };
            takenAt?: { gte?: string; lte?: string };
            type?: { eq?: "IMAGE" | "VIDEO"; in?: Array<"IMAGE" | "VIDEO"> };
            visibility?: { eq?: FakeAsset["visibility"]; in?: FakeAsset["visibility"][] };
          };
        };
        // Like Immich v3.3.5: the deprecated withDeleted flag cannot be combined with filter.
        if (search.filter && search.withDeleted !== undefined) {
          return json({
            message: "Validation failed",
            errors: [{ code: "custom", path: ["withDeleted"], message: "Deprecated field withDeleted cannot be combined with filter" }],
            statusCode: 400,
          }, 400);
        }
        const checksum = search.filter?.checksum?.eq;
        options.onMetadataSearch?.(checksum);
        if (checksum && options.searchErrorChecksums?.includes(checksum)) {
          return json({ message: "Search failed", statusCode: 500 }, 500);
        }
        if (checksum && options.incompleteSearchChecksums?.includes(checksum)) {
          return json({
            assets: { items: [], count: 0, total: 0, nextCursor: "stuck" },
            albums: { items: [], count: 0, total: 0 },
          });
        }
        const filter = search.filter;
        const matching = assets.filter((asset) => {
          // Trash state must be stated explicitly: without a trashedAt filter nothing trashed is returned.
          const trashedFilter = filter?.trashedAt;
          if (trashedFilter && "eq" in trashedFilter && trashedFilter.eq === null && asset.isTrashed) return false;
          if (trashedFilter && "ne" in trashedFilter && trashedFilter.ne === null && !asset.isTrashed) return false;
          if (!trashedFilter && asset.isTrashed) return false;
          if (filter?.checksum?.eq && asset.checksum !== filter.checksum.eq) return false;
          if (filter?.type?.eq && asset.type !== filter.type.eq) return false;
          if (filter?.type?.in && !filter.type.in.includes(asset.type)) return false;
          if (filter?.visibility?.eq && asset.visibility !== filter.visibility.eq) return false;
          if (filter?.visibility?.in && !filter.visibility.in.includes(asset.visibility)) return false;
          const takenAt = asset.exifInfo?.dateTimeOriginal ?? asset.fileCreatedAt;
          if (filter?.takenAt?.gte && takenAt < filter.takenAt.gte) return false;
          if (filter?.takenAt?.lte && takenAt > filter.takenAt.lte) return false;
          return true;
        });
        const cursor = Number(search.cursor ?? "0");
        const size = Math.max(1, Math.min(search.size ?? 250, options.pageSize ?? 250));
        const items = matching.slice(cursor, cursor + size);
        const nextCursor = cursor + items.length < matching.length ? String(cursor + items.length) : null;
        return json({
          // Like Immich v3.3.5: `total` is the size of this page, not of the whole result.
          assets: { items, nextCursor, count: items.length, total: items.length },
          albums: { items: [], nextCursor: null, count: 0, total: 0 },
        });
      }

      if (req.method === "GET" && path === "/api/albums") {
        if (!permissions.includes("all") && !permissions.includes("album.read")) {
          return json({ message: "Missing album.read permission", statusCode: 403 }, 403);
        }
        const assetId = url.searchParams.get("assetId");
        options.onAlbumList?.(assetId ?? undefined);
        if (assetId && options.albumListFailures?.includes(assetId)) {
          return json({ message: "Album listing failed", statusCode: 500 }, 500);
        }
        if (assetId && addedAlbumAssetIds.has(assetId) && options.albumMembershipVerificationFailures?.includes(assetId)) {
          return json({ message: "Album membership verification failed", statusCode: 500 }, 500);
        }
        if (options.malformedAlbumResponses) return json({ albums: [] });
        const isOwned = url.searchParams.get("isOwned") === "true";
        const isShared = url.searchParams.get("isShared");
        const name = url.searchParams.get("name");
        const matching = albums.filter((album) =>
          (!assetId || album.assetIds.includes(assetId)) &&
          (!isOwned || options.returnForeignAlbumsForOwnedQueries || album.ownerId === user.id) &&
          (isShared === null || String(album.shared ?? false) === isShared) &&
          (name === null || album.albumName === name)
        );
        return json(matching.map(albumResponse));
      }

      if (req.method === "POST" && path === "/api/albums") {
        body = await req.json();
        requestRecord.body = body;
        if (!permissions.includes("all") && !permissions.includes("album.create")) {
          return json({ message: "Missing album.create permission", statusCode: 403 }, 403);
        }
        const create = (body as { albumName?: unknown; assetIds?: unknown }).albumName;
        if (typeof create !== "string") return json({ message: "albumName is required", statusCode: 400 }, 400);
        if (options.albumCreateFailures?.includes(create)) {
          return json({ message: "Album creation failed", statusCode: 500 }, 500);
        }
        const album: FakeAlbum = {
          id: `album-${albums.length + 1}`,
          albumName: create,
          ownerId: user.id,
          assetIds: [],
          shared: false,
        };
        albums.push(album);
        options.onAlbumCreate?.(create);
        if (options.malformedAlbumCreateResponse) {
          return json({ id: album.id, albumName: album.albumName, albumUsers: albumResponse(album).albumUsers }, 201);
        }
        return json(albumResponse(album), 201);
      }

      if (req.method === "PUT" && path === "/api/albums/assets") {
        body = await req.json();
        requestRecord.body = body;
        if (!permissions.includes("all") && !permissions.includes("albumAsset.create")) {
          return json({ message: "Missing albumAsset.create permission", statusCode: 403 }, 403);
        }
        const add = body as { albumIds?: unknown; assetIds?: unknown };
        const albumIds = Array.isArray(add.albumIds) ? add.albumIds : [];
        const assetIds = Array.isArray(add.assetIds) ? add.assetIds : [];
        if (albumIds.some((id) => typeof id !== "string") || assetIds.some((id) => typeof id !== "string")) {
          return json({ message: "Invalid album or asset IDs", statusCode: 400 }, 400);
        }
        if (albumIds.some((id) => options.albumAddFailures?.includes(id)) ||
          assetIds.some((id) => options.albumAddFailures?.includes(id))) {
          return json({ error: "ALBUM_ASSET", success: false });
        }
        for (const albumId of albumIds as string[]) {
          const album = albums.find((candidate) => candidate.id === albumId);
          if (!album) return json({ error: "ALBUM_NOT_FOUND", success: false });
          for (const assetId of assetIds as string[]) {
            if (!album.assetIds.includes(assetId)) album.assetIds.push(assetId);
            addedAlbumAssetIds.add(assetId);
          }
        }
        return json({ success: true });
      }

      if (req.method === "DELETE" && path === "/api/assets") {
        const del = (await req.json()) as { ids?: string[]; force?: boolean };
        requestRecord.body = del;
        if (!permissions.includes("all") && !permissions.includes("asset.delete")) {
          return json({ message: "Missing asset.delete permission", statusCode: 403 }, 403);
        }
        const ids = del.ids ?? [];
        await options.onTrash?.(ids);
        if (ids.some((id) => options.trashFailures?.includes(id))) {
          return json({ message: "Trash failed", statusCode: 500 }, 500);
        }
        for (const id of ids) {
          if (del.force === true) {
            const index = assets.findIndex((candidate) => candidate.id === id);
            if (index >= 0) assets.splice(index, 1);
          } else {
            const asset = assets.find((candidate) => candidate.id === id);
            if (asset) asset.isTrashed = true;
          }
        }
        return new Response(null, { status: 204 });
      }

      if (path === "/api/tags" || path === "/api/tags/assets") {
        const need = (permission: string) =>
          !permissions.includes("all") && !permissions.includes(permission)
            ? json({ message: `Missing ${permission} permission`, statusCode: 403 }, 403)
            : undefined;
        const tagResponse = (tag: FakeTag) => ({
          ...tag,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        });
        if (req.method === "GET" && path === "/api/tags") {
          const denied = need("tag.read");
          if (denied) return denied;
          if (options.tagListFailures) return json({ message: "Tag listing failed", statusCode: 500 }, 500);
          return json(tags.map(tagResponse));
        }
        if (req.method === "PUT" && path === "/api/tags") {
          body = await req.json();
          requestRecord.body = body;
          const denied = need("tag.create");
          if (denied) return denied;
          const values = (body as { tags?: string[] }).tags ?? [];
          if (values.some((value) => options.tagUpsertFailures?.includes(value))) {
            return json({ message: "Tag upsert failed", statusCode: 500 }, 500);
          }
          const result: FakeTag[] = [];
          for (const value of values) {
            let tag = tags.find((candidate) => candidate.value === value);
            if (!tag) {
              tag = { id: `tag-${tags.length + 1}`, name: value.split("/").pop() ?? value, value };
              tags.push(tag);
            }
            result.push(tag);
          }
          return json(result.map(tagResponse));
        }
        if (req.method === "PUT" && path === "/api/tags/assets") {
          body = await req.json();
          requestRecord.body = body;
          const denied = need("tag.asset");
          if (denied) return denied;
          const { assetIds = [], tagIds = [] } = body as { assetIds?: string[]; tagIds?: string[] };
          if (assetIds.some((id) => options.tagAssignFailures?.includes(id))) {
            return json({ message: "Tag assignment failed", statusCode: 500 }, 500);
          }
          let count = 0;
          for (const assetId of assetIds) {
            const asset = assets.find((candidate) => candidate.id === assetId);
            if (!asset || options.tagAssignNoOp) continue;
            asset.tags ??= [];
            for (const tagId of tagIds) {
              const tag = tags.find((candidate) => candidate.id === tagId);
              if (tag && !asset.tags.some((candidate) => candidate.id === tagId)) {
                asset.tags.push(tag);
                count++;
              }
            }
          }
          return json({ count });
        }
      }

      const assetMatch = path.match(/^\/api\/assets\/([^/]+)$/);
      if (req.method === "GET" && assetMatch) {
        const id = decodeURIComponent(assetMatch[1] ?? "");
        if (options.assetInfoFailures?.includes(id)) {
          return json({ message: "Asset lookup failed", statusCode: 500 }, 500);
        }
        const asset = assets.find((candidate) => candidate.id === id);
        const deferred = deferredExif.get(id);
        if (asset && deferred !== undefined && deferred > 0) {
          deferredExif.set(id, deferred - 1);
          const { exifInfo: _pending, ...withoutExif } = asset;
          return json({
            ...withoutExif,
            fileModifiedAt: asset.fileModifiedAt ?? asset.fileCreatedAt,
            isFavorite: asset.isFavorite ?? false,
            duration: asset.duration ?? null,
          });
        }
        return asset
          ? json({
            ...asset,
            fileModifiedAt: asset.fileModifiedAt ?? asset.fileCreatedAt,
            isFavorite: asset.isFavorite ?? false,
            duration: asset.duration ?? null,
          })
          : json({ message: "Asset not found", statusCode: 404 }, 404);
      }

      if (req.method === "PUT" && assetMatch) {
        const id = decodeURIComponent(assetMatch[1] ?? "");
        await options.onAssetUpdate?.(id);
        body = await req.json();
        requestRecord.body = body;
        if (!permissions.includes("all") && !permissions.includes("asset.update")) {
          return json({ message: "Missing asset.update permission", statusCode: 403 }, 403);
        }
        if (options.updateFailures?.includes(id)) {
          return json({ message: "Asset update failed", statusCode: 500 }, 500);
        }
        const asset = assets.find((candidate) => candidate.id === id);
        if (!asset) return json({ message: "Asset not found", statusCode: 404 }, 404);
        const update = body as {
          dateTimeOriginal?: string;
          isFavorite?: boolean;
          visibility?: FakeAsset["visibility"];
          description?: string;
          rating?: number | null;
          latitude?: number;
          longitude?: number;
        };
        if (update.dateTimeOriginal !== undefined && !options.ignoreDateUpdates) {
          // Mirrors Immich deriving the zone from the offset carried by dateTimeOriginal.
          const offset = /([+-])(\d{2}):(\d{2})$/.exec(update.dateTimeOriginal);
          const instant = new Date(update.dateTimeOriginal);
          if (Number.isNaN(instant.getTime())) return json({ message: "Invalid dateTimeOriginal", statusCode: 400 }, 400);
          asset.exifInfo ??= {};
          asset.exifInfo.dateTimeOriginal = instant.toISOString();
          asset.exifInfo.timeZone = offset ? `UTC${offset[1]}${Number(offset[2])}${offset[3] === "00" ? "" : `:${offset[3]}`}` : "UTC";
        }
        if (update.isFavorite !== undefined) asset.isFavorite = update.isFavorite;
        if (update.visibility !== undefined) asset.visibility = update.visibility;
        asset.exifInfo ??= {};
        if (update.description !== undefined) asset.exifInfo.description = update.description;
        if (update.rating !== undefined) asset.exifInfo.rating = update.rating;
        if (update.latitude !== undefined) asset.exifInfo.latitude = update.latitude;
        if (update.longitude !== undefined) asset.exifInfo.longitude = update.longitude;
        return json({
          ...asset,
          fileModifiedAt: asset.fileModifiedAt ?? asset.fileCreatedAt,
          isFavorite: asset.isFavorite ?? false,
          duration: asset.duration ?? null,
        });
      }

      const originalMatch = path.match(/^\/api\/assets\/([^/]+)\/original$/);
      if (req.method === "GET" && originalMatch) {
        const id = decodeURIComponent(originalMatch[1] ?? "");
        await options.onDownload?.(id);
        if (options.downloadFailures?.includes(id)) {
          return json({ message: "Original download failed", statusCode: 500 }, 500);
        }
        const bytes = options.originals?.[id] ?? new TextEncoder().encode(`original:${id}`);
        const splitAt = Math.ceil(bytes.byteLength / 2);
        let chunk = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (chunk === 0 && splitAt > 0) controller.enqueue(bytes.slice(0, splitAt));
            else if (chunk === 1 && splitAt < bytes.byteLength) controller.enqueue(bytes.slice(splitAt));
            else controller.close();
            chunk++;
          },
        }), {
          headers: {
            "content-type": assets.find((asset) => asset.id === id)?.originalMimeType ?? "application/octet-stream",
            "content-length": String(bytes.byteLength),
          },
        });
      }

      if (req.method === "POST" && path === "/api/assets") {
        const form = await req.formData();
        const media = form.get("assetData");
        if (!(media instanceof Blob)) return json({ message: "assetData is required", statusCode: 400 }, 400);
        const fileName = String(form.get("filename") ?? ("name" in media ? media.name : "upload.bin"));
        requestRecord.body = {
          filename: fileName,
          livePhotoVideoId: form.get("livePhotoVideoId"),
          checksum: req.headers.get("x-immich-checksum"),
          isFavorite: form.get("isFavorite"),
          visibility: form.get("visibility"),
        };
        if (options.uploadFailures?.includes(fileName)) {
          return json({ message: "Upload failed", statusCode: 500 }, 500);
        }
        const bytes = new Uint8Array(await media.arrayBuffer());
        const actualChecksum = createHash("sha1").update(bytes).digest("base64");
        const id = `uploaded-${assets.length + 1}`;
        const createdAt = String(form.get("fileCreatedAt") ?? new Date(0).toISOString());
        const mimeType = media.type || "application/octet-stream";
        const uploaded: FakeAsset = {
          id,
          checksum: options.uploadChecksumMismatch?.includes(fileName) ? `mismatch-${actualChecksum}` : actualChecksum,
          ownerId: user.id,
          originalFileName: fileName,
          originalMimeType: mimeType,
          type: mimeType.startsWith("video/") ? "VIDEO" : "IMAGE",
          visibility: String(form.get("visibility") ?? "timeline") as FakeAsset["visibility"],
          isTrashed: false,
          fileCreatedAt: createdAt,
          fileModifiedAt: String(form.get("fileModifiedAt") ?? createdAt),
          isFavorite: String(form.get("isFavorite")) === "true",
          livePhotoVideoId: form.get("livePhotoVideoId") ? String(form.get("livePhotoVideoId")) : null,
          duration: form.get("duration") ? Number(form.get("duration")) : null,
          exifInfo: { fileSizeInByte: bytes.byteLength, dateTimeOriginal: createdAt },
        };
        assets.push(uploaded);
        if (options.deferExifGets !== undefined) deferredExif.set(id, options.deferExifGets);
        uploadedMedia.push({
          id,
          fileName,
          bytes,
          livePhotoVideoId: uploaded.livePhotoVideoId ?? null,
        });
        return json({ id, status: "created" }, 201);
      }

      return json({ message: "not found", statusCode: 404 }, 404);
    },
  });
  // Never reuse a port within this process: clients may pool keep-alive sockets to a stopped fake server,
  // and a new server on the same port would then receive a dead connection (an intermittent "request failed").
  let server = start();
  const rejected: Array<{ stop(force?: boolean): unknown }> = [];
  while (usedPorts.has(server.port!)) {
    rejected.push(server);
    server = start();
  }
  rejected.forEach((duplicate) => duplicate.stop(true));
  usedPorts.add(server.port!);

  return {
    url: `http://127.0.0.1:${server.port}/api`,
    apiKey,
    requests,
    uploadedMedia,
    stop: () => server.stop(true),
  };
}
