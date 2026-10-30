import {
  AssetVisibility,
  getAssetInfo,
  isHttpError,
  updateAsset,
  type AssetResponseDto,
  type UpdateAssetDto,
} from "@immich/sdk";
import { findAssetsByChecksum } from "./asset-search.ts";
import { checkInstance } from "./check.ts";
import { requestOpts, validateInstanceInput, type Instance } from "./instance.ts";
import { applyAlbumMembershipAdditions, planAlbumMembershipAdditions } from "./metadata-albums.ts";

export type MetadataField = "isFavorite" | "visibility" | "description" | "rating" | "location" | "albums";

export type MetadataFieldsOptions = {
  source: Instance;
  target: Instance;
  /** Explicit source asset IDs. Each target is located by checksum. */
  assetIds: string[];
  dryRun?: boolean;
  includeAlbums?: boolean;
  signal?: AbortSignal;
};

export type MetadataFieldAssetStatus =
  | "updated"
  | "would-update"
  | "already-synced"
  | "in-target-trash"
  | "failed"
  | "cancelled";

export type MetadataFieldAssetResult = {
  id: string;
  fileName: string;
  status: MetadataFieldAssetStatus;
  changedFields: MetadataField[];
  changedAlbums: string[];
  targetId?: string;
  message?: string;
};

export type MetadataFieldsSummary = {
  assetsSelected: number;
  updated: number;
  wouldUpdate: number;
  alreadySynced: number;
  inTargetTrash: number;
  failed: number;
  cancelled: number;
};

export type MetadataFieldsEvent =
  | { type: "warning"; message: string }
  | {
    type: "asset";
    id: string;
    fileName: string;
    status: MetadataFieldAssetStatus;
    changedFields: MetadataField[];
    changedAlbums: string[];
    message?: string;
  }
  | { type: "summary"; summary: MetadataFieldsSummary };

export type MetadataFieldsResult = {
  kind: "metadata-fields-run";
  sourceAlias: string;
  targetAlias: string;
  sourceVersion: string;
  targetVersion: string;
  warnings: string[];
  assets: MetadataFieldAssetResult[];
  summary: MetadataFieldsSummary;
  events: MetadataFieldsEvent[];
};

export class MetadataFieldsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataFieldsError";
  }
}

const SCOPE_WARNING =
  "This operation syncs selected asset fields only: favorite, timeline/archive visibility, nonempty description, rating, and complete GPS pairs.";
const ALBUM_SCOPE_WARNING =
  "With includeAlbums enabled, owned source album memberships are added to exact-name target albums; target-only memberships and album settings are preserved.";
const SOURCE_PERMISSIONS = ["user.read", "asset.read"];
const TARGET_PERMISSIONS = ["user.read", "asset.read", "asset.update"];

function safeError(error: unknown): string {
  if (isHttpError(error)) return `HTTP ${error.status}`;
  return error instanceof Error ? error.message : "request failed";
}

function isSupportedVisibility(value: unknown): value is AssetVisibility.Timeline | AssetVisibility.Archive {
  return value === AssetVisibility.Timeline || value === AssetVisibility.Archive;
}

function validateOptions(options: MetadataFieldsOptions): void {
  for (const [label, instance] of [["source", options.source], ["target", options.target]] as const) {
    const problems = validateInstanceInput(instance);
    if (problems.length) throw new MetadataFieldsError(`${label} instance is invalid: ${problems.join(" ")}`);
  }
  if (!Array.isArray(options.assetIds) || options.assetIds.length === 0) {
    throw new MetadataFieldsError("At least one source asset ID must be selected.");
  }
  if (options.assetIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))) {
    throw new MetadataFieldsError("Every source asset ID must be a valid asset identifier.");
  }
  if (new Set(options.assetIds).size !== options.assetIds.length) {
    throw new MetadataFieldsError("Source asset IDs must not contain duplicates.");
  }
  if (options.dryRun !== undefined && typeof options.dryRun !== "boolean") {
    throw new MetadataFieldsError("dryRun must be a boolean.");
  }
  if (options.includeAlbums !== undefined && typeof options.includeAlbums !== "boolean") {
    throw new MetadataFieldsError("includeAlbums must be a boolean.");
  }
}

function normalizedApiUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${url.pathname}`;
}

async function preflight(instance: Instance, label: "source" | "target", includeAlbums: boolean) {
  const result = await checkInstance(instance);
  const user = result.user;
  const version = result.version;
  if (!result.ok || !user || !version) {
    throw new MetadataFieldsError(`${label} instance preflight failed${result.error ? ` at ${result.error.stage}` : ""}.`);
  }
  const required = [...(label === "source" ? SOURCE_PERMISSIONS : TARGET_PERMISSIONS)];
  if (includeAlbums) {
    required.push("album.read");
    if (label === "target") required.push("album.create", "albumAsset.create");
  }
  const missing = result.permissions.includes("all") ? [] : required.filter((permission) => !result.permissions.includes(permission));
  if (missing.length > 0) {
    throw new MetadataFieldsError(`${label} metadata fields requires permissions: ${missing.join(", ")}.`);
  }
  return { user, version, permissions: result.permissions };
}

function validateAssetResponse(asset: AssetResponseDto, id: string, label: string): void {
  if (
    !asset ||
    typeof asset.id !== "string" ||
    asset.id.length === 0 ||
    asset.id !== id ||
    typeof asset.checksum !== "string" ||
    asset.checksum.length === 0 ||
    typeof asset.ownerId !== "string" ||
    typeof asset.isTrashed !== "boolean" ||
    typeof asset.isFavorite !== "boolean" ||
    typeof asset.originalFileName !== "string" ||
    typeof asset.visibility !== "string"
  ) {
    throw new Error(`Immich returned an incomplete ${label} asset response.`);
  }
}

function metadataUpdate(source: AssetResponseDto, target: AssetResponseDto): {
  update: UpdateAssetDto;
  fields: MetadataField[];
} {
  const update: UpdateAssetDto = {};
  const fields: MetadataField[] = [];

  if (source.isFavorite !== target.isFavorite) {
    update.isFavorite = source.isFavorite;
    fields.push("isFavorite");
  }
  if (source.visibility !== target.visibility) {
    update.visibility = source.visibility as AssetVisibility.Timeline | AssetVisibility.Archive;
    fields.push("visibility");
  }

  const sourceDescription = source.exifInfo?.description;
  if (typeof sourceDescription === "string" && sourceDescription.trim().length > 0 &&
    sourceDescription !== target.exifInfo?.description) {
    update.description = sourceDescription;
    fields.push("description");
  }

  const sourceRating = source.exifInfo?.rating;
  if (typeof sourceRating === "number" && Number.isFinite(sourceRating) &&
    sourceRating !== target.exifInfo?.rating) {
    update.rating = sourceRating;
    fields.push("rating");
  }

  const sourceLatitude = source.exifInfo?.latitude;
  const sourceLongitude = source.exifInfo?.longitude;
  if (
    typeof sourceLatitude === "number" && Number.isFinite(sourceLatitude) &&
    typeof sourceLongitude === "number" && Number.isFinite(sourceLongitude) &&
    (sourceLatitude !== target.exifInfo?.latitude || sourceLongitude !== target.exifInfo?.longitude)
  ) {
    update.latitude = sourceLatitude;
    update.longitude = sourceLongitude;
    fields.push("location");
  }

  return { update, fields };
}

function updateMatches(asset: AssetResponseDto, update: UpdateAssetDto): boolean {
  return (update.isFavorite === undefined || asset.isFavorite === update.isFavorite) &&
    (update.visibility === undefined || asset.visibility === update.visibility) &&
    (update.description === undefined || asset.exifInfo?.description === update.description) &&
    (update.rating === undefined || asset.exifInfo?.rating === update.rating) &&
    (update.latitude === undefined || asset.exifInfo?.latitude === update.latitude) &&
    (update.longitude === undefined || asset.exifInfo?.longitude === update.longitude);
}

function summarize(assets: MetadataFieldAssetResult[]): MetadataFieldsSummary {
  return {
    assetsSelected: assets.length,
    updated: assets.filter((asset) => asset.status === "updated").length,
    wouldUpdate: assets.filter((asset) => asset.status === "would-update").length,
    alreadySynced: assets.filter((asset) => asset.status === "already-synced").length,
    inTargetTrash: assets.filter((asset) => asset.status === "in-target-trash").length,
    failed: assets.filter((asset) => asset.status === "failed").length,
    cancelled: assets.filter((asset) => asset.status === "cancelled").length,
  };
}

function resultFor(
  id: string,
  fileName: string,
  status: MetadataFieldAssetStatus,
  changedFields: MetadataField[],
  details: { targetId?: string; message?: string; changedAlbums?: string[] } = {},
): MetadataFieldAssetResult {
  return { id, fileName, status, changedFields, changedAlbums: [], ...details };
}

async function syncOneAsset(
  options: MetadataFieldsOptions,
  id: string,
  sourceOwnerId: string,
  targetOwnerId: string,
): Promise<MetadataFieldAssetResult> {
  const { signal } = options;
  let fileName = id;
  let targetId: string | undefined;
  let changedFields: MetadataField[] = [];
  let changedAlbums: string[] = [];
  try {
    signal?.throwIfAborted();
    const source = await getAssetInfo({ id }, { ...requestOpts(options.source), signal });
    validateAssetResponse(source, id, "source");
    if (source.ownerId !== sourceOwnerId) throw new Error("Source asset is not owned by the configured source user.");
    if (source.isTrashed) throw new Error("Trashed source assets cannot be synchronized.");
    if (!isSupportedVisibility(source.visibility)) throw new Error("Hidden or locked source assets cannot be synchronized.");
    fileName = source.originalFileName;

    const matches = await findAssetsByChecksum(options.target, source.checksum, signal);
    if (matches.length === 0) throw new Error("No target asset with the source checksum was found.");
    if (matches.length > 1) throw new Error("Multiple target assets match the source checksum; refusing an ambiguous update.");

    const target = matches[0] as AssetResponseDto;
    validateAssetResponse(target, target.id, "target");
    if (target.ownerId !== targetOwnerId) throw new Error("Checksum match is not owned by the configured target user.");
    if (target.isTrashed) {
      return resultFor(id, fileName, "in-target-trash", [], { targetId: target.id });
    }
    if (!isSupportedVisibility(target.visibility)) {
      throw new Error("Hidden or locked target assets cannot be synchronized.");
    }
    targetId = target.id;

    const { update, fields: scalarFields } = metadataUpdate(source, target);
    const albumPlan = options.includeAlbums
      ? await planAlbumMembershipAdditions(
        options.source,
        options.target,
        source.id,
        target.id,
        sourceOwnerId,
        targetOwnerId,
        signal,
      )
      : [];
    signal?.throwIfAborted();

    const plannedAlbums = albumPlan.map((addition) => addition.albumName);
    const plannedFields: MetadataField[] = [...scalarFields];
    if (plannedAlbums.length > 0) plannedFields.push("albums");
    if (plannedFields.length === 0) {
      return resultFor(id, fileName, "already-synced", [], { targetId });
    }
    if (options.dryRun) {
      return resultFor(id, fileName, "would-update", plannedFields, { targetId, changedAlbums: plannedAlbums });
    }

    if (scalarFields.length > 0) {
      signal?.throwIfAborted();
      await updateAsset({ id: target.id, updateAssetDto: update }, { ...requestOpts(options.target), signal });
      signal?.throwIfAborted();
      const verified = await getAssetInfo({ id: target.id }, { ...requestOpts(options.target), signal });
      validateAssetResponse(verified, target.id, "updated target");
      if (verified.ownerId !== targetOwnerId || verified.checksum !== source.checksum || !updateMatches(verified, update)) {
        throw new Error("Updated target metadata did not match the requested values after verification.");
      }
      changedFields = scalarFields;
    }

    if (albumPlan.length > 0) {
      const applied = await applyAlbumMembershipAdditions(
        options.target,
        target.id,
        targetOwnerId,
        albumPlan,
        signal,
      );
      changedAlbums = applied.added;
      if (changedAlbums.length > 0) changedFields = [...changedFields, "albums"];
      if (applied.cancelled) {
        return resultFor(id, fileName, "cancelled", changedFields, {
          targetId,
          changedAlbums,
          message: "Operation cancelled; verified changes were retained.",
        });
      }
      if (applied.errors.length > 0) {
        return resultFor(id, fileName, "failed", changedFields, {
          targetId,
          changedAlbums,
          message: applied.errors.join("; "),
        });
      }
    }

    return resultFor(id, fileName, "updated", changedFields, { targetId, changedAlbums });
  } catch (error) {
    const cancelled = signal?.aborted === true;
    return resultFor(id, fileName, cancelled ? "cancelled" : "failed", changedFields, {
      ...(targetId ? { targetId } : {}),
      changedAlbums,
      message: cancelled ? "Operation cancelled; verified changes were retained." : safeError(error),
    });
  }
}

export async function syncMetadataFields(options: MetadataFieldsOptions): Promise<MetadataFieldsResult> {
  validateOptions(options);
  const [sourceCheck, targetCheck] = await Promise.all([
    preflight(options.source, "source", options.includeAlbums === true),
    preflight(options.target, "target", options.includeAlbums === true),
  ]);
  if (
    normalizedApiUrl(options.source.apiUrl) === normalizedApiUrl(options.target.apiUrl) &&
    sourceCheck.user.id === targetCheck.user.id
  ) {
    throw new MetadataFieldsError("Source and target must be different servers or users.");
  }

  const assets: MetadataFieldAssetResult[] = [];
  for (const id of options.assetIds) {
    if (options.signal?.aborted) {
      assets.push(resultFor(id, id, "cancelled", [], { message: "Operation cancelled before this asset was processed." }));
      continue;
    }
    try {
      assets.push(await syncOneAsset(options, id, sourceCheck.user.id, targetCheck.user.id));
    } catch (error) {
      assets.push(resultFor(
        id,
        id,
        options.signal?.aborted ? "cancelled" : "failed",
        [],
        { message: options.signal?.aborted ? "Operation cancelled." : safeError(error) },
      ));
    }
  }

  const summary = summarize(assets);
  const warnings = [SCOPE_WARNING, ...(options.includeAlbums ? [ALBUM_SCOPE_WARNING] : [])];
  const events: MetadataFieldsEvent[] = [
    ...warnings.map((message) => ({ type: "warning" as const, message })),
    ...assets.map(({ id, fileName, status, changedFields, changedAlbums, message }) => ({
      type: "asset" as const,
      id,
      fileName,
      status,
      changedFields,
      changedAlbums,
      ...(message ? { message } : {}),
    })),
    { type: "summary", summary },
  ];

  return {
    kind: "metadata-fields-run",
    sourceAlias: options.source.alias,
    targetAlias: options.target.alias,
    sourceVersion: sourceCheck.version,
    targetVersion: targetCheck.version,
    warnings,
    assets,
    summary,
    events,
  };
}