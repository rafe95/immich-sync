import { describeHttpError } from "./http-error.ts";
import {
  AssetVisibility,
  getAssetInfo,
  updateAsset,
  type AssetResponseDto,
  type UpdateAssetDto,
} from "@immich/sdk";
import { findAssetsByChecksum } from "./asset-search.ts";
import { checkInstance } from "./check.ts";
import { requestOpts, validateInstanceInput, type Instance } from "./instance.ts";
import { checkPermissions, metadataSyncPermissions } from "./permissions.ts";
import { applyAlbumMembershipAdditions, planAlbumMembershipAdditions } from "./metadata-albums.ts";
import { applyTagAdditions, planTagAdditions, tagValues } from "./metadata-tags.ts";

export type MetadataField =
  | "isFavorite"
  | "visibility"
  | "description"
  | "rating"
  | "location"
  | "dateTimeOriginal"
  | "albums"
  | "tags";

export type MetadataFieldsOptions = {
  source: Instance;
  target: Instance;
  /** Explicit source asset IDs. Each target is located by checksum. */
  assetIds: string[];
  dryRun?: boolean;
  includeAlbums?: boolean;
  /** With includeAlbums, also create missing owned target albums by exact name. Off by default. */
  createMissingAlbums?: boolean;
  /** Add source tags (matched by exact value, created on the target if missing) to the target asset. */
  includeTags?: boolean;
  signal?: AbortSignal;
  /**
   * Called synchronously as each asset finishes (in assetIds order, before the run resolves). Contains
   * no credentials. Errors thrown by it are ignored.
   */
  onAsset?: (asset: MetadataFieldAssetResult) => void;
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
  changedTags: string[];
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
    changedTags: string[];
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
  "This operation syncs selected asset fields only: favorite, timeline/archive visibility, nonempty description, rating, and complete GPS pairs, date taken with time zone offset, and (when enabled) tags.";
const ALBUM_SCOPE_WARNING =
  "With includeAlbums enabled, owned source album memberships are added to exact-name target albums; target-only memberships and album settings are preserved.";
const ALBUM_CREATE_WARNING =
  "With createMissingAlbums enabled, missing owned target albums are created (private, name only) before the asset is added.";
const TAG_SCOPE_WARNING =
  "With includeTags enabled, source tags are added to the target asset by exact value, creating missing target tags; target-only tags are preserved.";

function safeError(error: unknown): string {
  const http = describeHttpError(error);
  if (http) return http;
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
  for (const name of ["createMissingAlbums", "includeTags"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "boolean") {
      throw new MetadataFieldsError(`${name} must be a boolean.`);
    }
  }
  if (options.createMissingAlbums === true && options.includeAlbums !== true) {
    throw new MetadataFieldsError("createMissingAlbums requires includeAlbums.");
  }
}

function normalizedApiUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${url.pathname}`;
}

async function preflight(
  instance: Instance,
  label: "source" | "target",
  includeAlbums: boolean,
  createMissingAlbums: boolean,
  includeTags: boolean,
) {
  const result = await checkInstance(instance);
  const user = result.user;
  const version = result.version;
  if (!result.ok || !user || !version) {
    throw new MetadataFieldsError(`${label} instance preflight failed${result.error ? ` at ${result.error.stage}` : ""}.`);
  }
  const { missing } = checkPermissions(
    result.permissions,
    metadataSyncPermissions(label, { includeAlbums, createMissingAlbums, includeTags }),
  );
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

/**
 * Offset in minutes east of UTC for a time zone at an instant. Accepts Immich's fixed
 * "UTC+H[:MM]" form and IANA names; returns undefined when it cannot be determined reliably.
 */
export function timeZoneOffsetMinutes(timeZone: unknown, instantMs: number): number | undefined {
  if (typeof timeZone !== "string" || timeZone.length === 0) return undefined;
  const fixed = /^UTC(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/.exec(timeZone);
  if (fixed) {
    if (!fixed[1]) return 0;
    const minutes = Number(fixed[2]) * 60 + Number(fixed[3] ?? 0);
    return fixed[1] === "-" ? -minutes : minutes;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(new Date(instantMs));
    const name = parts.find((part) => part.type === "timeZoneName")?.value;
    if (name === "GMT") return 0;
    const match = name ? /^GMT([+-])(\d{2}):(\d{2})$/.exec(name) : null;
    if (!match) return undefined;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === "-" ? -minutes : minutes;
  } catch {
    return undefined;
  }
}

function localIsoWithOffset(instantMs: number, offsetMinutes: number): string {
  const local = new Date(instantMs + offsetMinutes * 60_000).toISOString().slice(0, 23);
  const abs = Math.abs(offsetMinutes);
  const sign = offsetMinutes < 0 ? "-" : "+";
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

type DateExpectation = { instantMs: number; offsetMinutes: number };

function metadataUpdate(source: AssetResponseDto, target: AssetResponseDto): {
  update: UpdateAssetDto;
  fields: MetadataField[];
  date?: DateExpectation;
} {
  let date: DateExpectation | undefined;
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

  // Immich's update DTO has no time zone field; the zone is derived by the server from the offset
  // carried in dateTimeOriginal. Only sync when the source zone is known and resolvable, and verify it.
  const sourceTaken = source.exifInfo?.dateTimeOriginal;
  const sourceMs = typeof sourceTaken === "string" ? Date.parse(sourceTaken) : Number.NaN;
  if (Number.isFinite(sourceMs)) {
    const offset = timeZoneOffsetMinutes(source.exifInfo?.timeZone, sourceMs);
    if (offset !== undefined) {
      const targetTaken = target.exifInfo?.dateTimeOriginal;
      const targetMs = typeof targetTaken === "string" ? Date.parse(targetTaken) : Number.NaN;
      if (targetMs !== sourceMs || timeZoneOffsetMinutes(target.exifInfo?.timeZone, sourceMs) !== offset) {
        update.dateTimeOriginal = localIsoWithOffset(sourceMs, offset);
        date = { instantMs: sourceMs, offsetMinutes: offset };
        fields.push("dateTimeOriginal");
      }
    }
  }

  return { update, fields, ...(date ? { date } : {}) };
}

function updateMatches(asset: AssetResponseDto, update: UpdateAssetDto, date?: DateExpectation): boolean {
  const dateOk = !date || (
    Date.parse(asset.exifInfo?.dateTimeOriginal ?? "") === date.instantMs &&
    timeZoneOffsetMinutes(asset.exifInfo?.timeZone, date.instantMs) === date.offsetMinutes
  );
  return dateOk && (update.isFavorite === undefined || asset.isFavorite === update.isFavorite) &&
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
  details: { targetId?: string; message?: string; changedAlbums?: string[]; changedTags?: string[] } = {},
): MetadataFieldAssetResult {
  return { id, fileName, status, changedFields, changedAlbums: [], changedTags: [], ...details };
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
  let changedTags: string[] = [];
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

    const { update, fields: scalarFields, date } = metadataUpdate(source, target);
    const albumPlan = options.includeAlbums
      ? await planAlbumMembershipAdditions(
        options.source,
        options.target,
        source.id,
        target.id,
        sourceOwnerId,
        targetOwnerId,
        options.createMissingAlbums === true,
        signal,
      )
      : [];
    const tagPlan = options.includeTags
      ? await planTagAdditions(options.target, source.tags, target.tags, signal)
      : undefined;
    signal?.throwIfAborted();

    const plannedAlbums = albumPlan.map((addition) => addition.albumName);
    const plannedTags = tagPlan?.values ?? [];
    const skippedAlbums = albumPlan.skippedMissing ?? [];
    const skippedNote = skippedAlbums.length > 0
      ? `Albums missing on target were not created (createMissingAlbums is off): ${skippedAlbums.map((name) => JSON.stringify(name)).join(", ")}.`
      : undefined;
    const plannedFields: MetadataField[] = [...scalarFields];
    if (plannedAlbums.length > 0) plannedFields.push("albums");
    if (plannedTags.length > 0) plannedFields.push("tags");
    if (plannedFields.length === 0) {
      return resultFor(id, fileName, "already-synced", [], { targetId, ...(skippedNote ? { message: skippedNote } : {}) });
    }
    if (options.dryRun) {
      return resultFor(id, fileName, "would-update", plannedFields, {
        targetId,
        changedAlbums: plannedAlbums,
        changedTags: plannedTags,
        ...(skippedNote ? { message: skippedNote } : {}),
      });
    }

    if (scalarFields.length > 0) {
      signal?.throwIfAborted();
      await updateAsset({ id: target.id, updateAssetDto: update }, { ...requestOpts(options.target), signal });
      signal?.throwIfAborted();
      const verified = await getAssetInfo({ id: target.id }, { ...requestOpts(options.target), signal });
      validateAssetResponse(verified, target.id, "updated target");
      if (verified.ownerId !== targetOwnerId || verified.checksum !== source.checksum || !updateMatches(verified, update, date)) {
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

    if (tagPlan && tagPlan.values.length > 0) {
      const applied = await applyTagAdditions(options.target, target.id, tagPlan, signal);
      if (applied.cancelled) {
        return resultFor(id, fileName, "cancelled", changedFields, {
          targetId,
          changedAlbums,
          message: "Operation cancelled; verified changes were retained.",
        });
      }
      if (applied.errors.length === 0) {
        signal?.throwIfAborted();
        const verified = await getAssetInfo({ id: target.id }, { ...requestOpts(options.target), signal });
        validateAssetResponse(verified, target.id, "tagged target");
        const present = new Set(tagValues(verified.tags));
        if (verified.ownerId !== targetOwnerId || !applied.added.every((value) => present.has(value))) {
          applied.errors.push("Target tags could not be verified after assignment.");
        } else {
          changedTags = applied.added;
          changedFields = [...changedFields, "tags"];
        }
      }
      if (applied.errors.length > 0) {
        return resultFor(id, fileName, "failed", changedFields, {
          targetId,
          changedAlbums,
          changedTags,
          message: applied.errors.join("; "),
        });
      }
    }

    return resultFor(id, fileName, "updated", changedFields, {
      targetId,
      changedAlbums,
      changedTags,
      ...(skippedNote ? { message: skippedNote } : {}),
    });
  } catch (error) {
    const cancelled = signal?.aborted === true;
    return resultFor(id, fileName, cancelled ? "cancelled" : "failed", changedFields, {
      ...(targetId ? { targetId } : {}),
      changedAlbums,
      changedTags,
      message: cancelled ? "Operation cancelled; verified changes were retained." : safeError(error),
    });
  }
}

export async function syncMetadataFields(options: MetadataFieldsOptions): Promise<MetadataFieldsResult> {
  validateOptions(options);
  const [sourceCheck, targetCheck] = await Promise.all([
    preflight(options.source, "source", options.includeAlbums === true, options.createMissingAlbums === true, options.includeTags === true),
    preflight(options.target, "target", options.includeAlbums === true, options.createMissingAlbums === true, options.includeTags === true),
  ]);
  if (
    normalizedApiUrl(options.source.apiUrl) === normalizedApiUrl(options.target.apiUrl) &&
    sourceCheck.user.id === targetCheck.user.id
  ) {
    throw new MetadataFieldsError("Source and target must be different servers or users.");
  }

  const assets: MetadataFieldAssetResult[] = [];
  const record = (asset: MetadataFieldAssetResult) => {
    assets.push(asset);
    try {
      options.onAsset?.(asset);
    } catch {
      // A failing listener must not affect the run.
    }
  };
  for (const id of options.assetIds) {
    if (options.signal?.aborted) {
      record(resultFor(id, id, "cancelled", [], { message: "Operation cancelled before this asset was processed." }));
      continue;
    }
    try {
      record(await syncOneAsset(options, id, sourceCheck.user.id, targetCheck.user.id));
    } catch (error) {
      record(resultFor(
        id,
        id,
        options.signal?.aborted ? "cancelled" : "failed",
        [],
        { message: options.signal?.aborted ? "Operation cancelled." : safeError(error) },
      ));
    }
  }

  const summary = summarize(assets);
  const warnings = [
    SCOPE_WARNING,
    ...(options.includeAlbums ? [ALBUM_SCOPE_WARNING] : []),
    ...(options.createMissingAlbums ? [ALBUM_CREATE_WARNING] : []),
    ...(options.includeTags ? [TAG_SCOPE_WARNING] : []),
  ];
  const events: MetadataFieldsEvent[] = [
    ...warnings.map((message) => ({ type: "warning" as const, message })),
    ...assets.map(({ id, fileName, status, changedFields, changedAlbums, changedTags, message }) => ({
      type: "asset" as const,
      id,
      fileName,
      status,
      changedFields,
      changedAlbums,
      changedTags,
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

/**
 * Validates both instances for a metadata sync (connection, version, permissions, same server/user)
 * without touching any asset. Lets callers refuse a run before any upload or other change.
 */
export async function preflightMetadataFields(
  options: Pick<MetadataFieldsOptions, "source" | "target" | "includeAlbums" | "createMissingAlbums" | "includeTags">,
): Promise<{ sourceVersion: string; targetVersion: string }> {
  for (const [label, instance] of [["source", options.source], ["target", options.target]] as const) {
    const problems = validateInstanceInput(instance);
    if (problems.length) throw new MetadataFieldsError(`${label} instance is invalid: ${problems.join(" ")}`);
  }
  if (options.createMissingAlbums === true && options.includeAlbums !== true) {
    throw new MetadataFieldsError("createMissingAlbums requires includeAlbums.");
  }
  const flags = [options.includeAlbums === true, options.createMissingAlbums === true, options.includeTags === true] as const;
  const [sourceCheck, targetCheck] = await Promise.all([
    preflight(options.source, "source", ...flags),
    preflight(options.target, "target", ...flags),
  ]);
  if (
    normalizedApiUrl(options.source.apiUrl) === normalizedApiUrl(options.target.apiUrl) &&
    sourceCheck.user.id === targetCheck.user.id
  ) {
    throw new MetadataFieldsError("Source and target must be different servers or users.");
  }
  return { sourceVersion: sourceCheck.version, targetVersion: targetCheck.version };
}
