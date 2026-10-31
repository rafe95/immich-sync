/** Read-only transfer planning for copy and move operations. */

import { describeHttpError } from "./http-error.ts";
import {
  AssetTypeEnum,
  AssetVisibility,
  getAssetInfo,
  type AssetResponseDto,
  type SearchFilter,
} from "@immich/sdk";
import { AssetSearchError, collectAssets, findAssetsByChecksum } from "./asset-search.ts";
import { checkInstance } from "./check.ts";
import { requestOpts, validateInstanceInput, type Instance } from "./instance.ts";
import { checkPermissions, metadataSyncPermissions, type MetadataSyncFlags, type Role } from "./permissions.ts";

export type TransferPlanOptions = {
  source: Instance;
  target: Instance;
  operation: "copy" | "move";
  kind?: "all" | "photos" | "videos";
  /** A date-taken window; omitting it includes all eligible dates. */
  range?: { from?: string; to: string };
  /**
   * Plan for a standalone metadata sync (sync_metadata), which classifies assets but never uploads or
   * downloads. The instance checks then require only metadataSyncPermissions (source read; target read
   * and asset.update; album/tag permissions only for the enabled options) instead of the copy roles.
   */
  metadataSync?: MetadataSyncFlags;
};

export type PlannedComponentStatus = "already-present" | "would-transfer" | "in-target-trash" | "failed";

export type PlannedComponent = {
  id: string;
  fileName: string;
  type: AssetTypeEnum;
  checksum: string;
  sizeBytes: number | null;
  status: PlannedComponentStatus;
  message?: string;
};

export type PlannedAsset = {
  id: string;
  fileName: string;
  type: AssetTypeEnum;
  status: PlannedComponentStatus;
  components: PlannedComponent[];
};

export type TransferPlanSummary = {
  assetsFound: number;
  componentsFound: number;
  totalBytes: number;
  bytesToTransfer: number;
  unknownSizeComponents: number;
  alreadyPresent: number;
  wouldTransfer: number;
  inTargetTrash: number;
  failed: number;
  /** Move candidates only; actual source trashing is not implemented by this preview. */
  wouldTrashAfterSuccessfulTransfer: number;
};

export type TransferPlanEvent =
  | { type: "warning"; message: string }
  | { type: "asset"; id: string; fileName: string; status: PlannedComponentStatus; message?: string }
  | { type: "summary"; summary: TransferPlanSummary };

export type TransferPlan = {
  kind: "transfer-preview";
  operation: "copy" | "move";
  sourceAlias: string;
  targetAlias: string;
  sourceVersion: string;
  targetVersion: string;
  warnings: string[];
  assets: PlannedAsset[];
  summary: TransferPlanSummary;
  events: TransferPlanEvent[];
};

export class TransferPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferPlanError";
  }
}

const PREVIEW_WARNING =
  "Metadata changes are not compared by this transfer-only preview. No files are uploaded or trashed.";

function safeRequestError(error: unknown): string {
  const http = describeHttpError(error);
  if (http) return http;
  if (error instanceof AssetSearchError) return error.message;
  return "request failed";
}

function validateOptions(options: TransferPlanOptions): void {
  for (const [label, instance] of [["source", options.source], ["target", options.target]] as const) {
    const problems = validateInstanceInput(instance);
    if (problems.length) throw new TransferPlanError(`${label} instance is invalid: ${problems.join(" ")}`);
  }
  if (options.operation !== "copy" && options.operation !== "move") {
    throw new TransferPlanError("Operation must be copy or move.");
  }
  if (options.kind && !["all", "photos", "videos"].includes(options.kind)) {
    throw new TransferPlanError("Kind must be all, photos or videos.");
  }
  if (options.range) {
    const { from, to } = options.range;
    const toTime = Date.parse(to);
    const fromTime = from === undefined ? null : Date.parse(from);
    if (!Number.isFinite(toTime) || (fromTime !== null && !Number.isFinite(fromTime))) {
      throw new TransferPlanError("Date range must contain valid ISO date values.");
    }
    if (fromTime !== null && fromTime > toTime) {
      throw new TransferPlanError("Date range start must not be after its end.");
    }
  }
}

function normalizedApiUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${url.pathname}`;
}


function isEligibleSourceAsset(asset: AssetResponseDto, ownerId: string): boolean {
  return asset.ownerId === ownerId &&
    !asset.isTrashed &&
    (asset.visibility === AssetVisibility.Timeline || asset.visibility === AssetVisibility.Archive);
}

function componentSize(asset: AssetResponseDto): number | null {
  const size = asset.exifInfo?.fileSizeInByte;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

function groupStatus(components: PlannedComponent[]): PlannedComponentStatus {
  if (components.some((component) => component.status === "failed")) return "failed";
  if (components.some((component) => component.status === "in-target-trash")) return "in-target-trash";
  if (components.some((component) => component.status === "would-transfer")) return "would-transfer";
  return "already-present";
}

function summarize(assets: PlannedAsset[], operation: TransferPlanOptions["operation"]): TransferPlanSummary {
  const components = assets.flatMap((asset) => asset.components);
  const transferableComponents = assets
    .filter((asset) => asset.status === "would-transfer")
    .flatMap((asset) => asset.components)
    .filter((component) => component.status === "would-transfer");
  const sourceComponents = components.filter((component) => component.checksum.length > 0);
  return {
    assetsFound: assets.length,
    componentsFound: sourceComponents.length,
    totalBytes: sourceComponents.reduce((total, component) => total + (component.sizeBytes ?? 0), 0),
    bytesToTransfer: transferableComponents.reduce((total, component) => total + (component.sizeBytes ?? 0), 0),
    unknownSizeComponents: sourceComponents.filter((component) => component.sizeBytes === null).length,
    alreadyPresent: assets.filter((asset) => asset.status === "already-present").length,
    wouldTransfer: assets.filter((asset) => asset.status === "would-transfer").length,
    inTargetTrash: assets.filter((asset) => asset.status === "in-target-trash").length,
    failed: assets.filter((asset) => asset.status === "failed").length,
    wouldTrashAfterSuccessfulTransfer: operation === "move"
      ? assets.filter((asset) => asset.status === "already-present" || asset.status === "would-transfer").length
      : 0,
  };
}

function searchFilter(
  visibility: AssetVisibility,
  type: AssetTypeEnum,
  range: TransferPlanOptions["range"],
): SearchFilter {
  return {
    visibility: { eq: visibility },
    type: { eq: type },
    ...(range
      ? { takenAt: { ...(range.from ? { gte: range.from } : {}), lte: range.to } }
      : {}),
  };
}

async function discoverSourceAssets(
  instance: Instance,
  kind: NonNullable<TransferPlanOptions["kind"]>,
  range: TransferPlanOptions["range"],
): Promise<AssetResponseDto[]> {
  const types = kind === "photos"
    ? [AssetTypeEnum.Image]
    : kind === "videos"
      ? [AssetTypeEnum.Video]
      : [AssetTypeEnum.Image, AssetTypeEnum.Video];
  const found = new Map<string, AssetResponseDto>();
  for (const visibility of [AssetVisibility.Timeline, AssetVisibility.Archive]) {
    for (const type of types) {
      const assets = await collectAssets(instance, searchFilter(visibility, type, range), false);
      for (const asset of assets) found.set(asset.id, asset);
    }
  }
  return [...found.values()];
}

function validatePreflight(
  label: string,
  check: Awaited<ReturnType<typeof checkInstance>>,
  role: Role,
): void {
  if (!check.ok) {
    throw new TransferPlanError(`${label} instance check failed during ${check.error?.stage ?? "unknown"}.`);
  }
  const roleCheck = check.roles?.[role];
  if (!roleCheck?.ok) {
    const missing = roleCheck?.missing.length ? `; missing ${roleCheck.missing.join(", ")}` : "";
    throw new TransferPlanError(`${label} instance cannot act as ${role.replace("-", " ")}${missing}.`);
  }
}

function validatePermissions(
  label: string,
  check: Awaited<ReturnType<typeof checkInstance>>,
  required: string[],
): void {
  if (!check.ok) {
    throw new TransferPlanError(`${label} instance check failed during ${check.error?.stage ?? "unknown"}.`);
  }
  const result = checkPermissions(check.permissions ?? [], required);
  if (!result.ok) {
    throw new TransferPlanError(`${label} instance cannot act for metadata sync; missing ${result.missing.join(", ")}.`);
  }
}

async function getLivePhotoVideo(
  instance: Instance,
  sourceAssets: Map<string, AssetResponseDto>,
  ownerId: string,
  id: string,
): Promise<AssetResponseDto> {
  const asset = sourceAssets.get(id) ?? await getAssetInfo({ id }, requestOpts(instance));
  if (asset.id !== id || asset.type !== AssetTypeEnum.Video) {
    throw new TransferPlanError("Live Photo companion is not a video asset.");
  }
  if (!isEligibleSourceAsset(asset, ownerId)) {
    throw new TransferPlanError("Live Photo companion is not an eligible source asset.");
  }
  if (!asset.checksum) throw new TransferPlanError("Live Photo companion has no checksum.");
  return asset;
}

async function classifyComponent(
  instance: Instance,
  asset: AssetResponseDto,
): Promise<PlannedComponent> {
  const base = {
    id: asset.id,
    fileName: asset.originalFileName,
    type: asset.type,
    checksum: asset.checksum,
    sizeBytes: componentSize(asset),
  };
  if (!asset.checksum) {
    return { ...base, status: "failed", message: "Source asset has no checksum." };
  }
  try {
    const matches = await findAssetsByChecksum(instance, asset.checksum);
    if (matches.some((match) => !match.isTrashed)) return { ...base, status: "already-present" };
    if (matches.some((match) => match.isTrashed)) return { ...base, status: "in-target-trash" };
    return { ...base, status: "would-transfer" };
  } catch (error) {
    return { ...base, status: "failed", message: `Target checksum lookup failed (${safeRequestError(error)}).` };
  }
}

async function buildGroups(
  source: Instance,
  sourceAssets: AssetResponseDto[],
  ownerId: string,
  kind: NonNullable<TransferPlanOptions["kind"]>,
): Promise<Array<{ primary: AssetResponseDto; components: Array<AssetResponseDto | { id: string; error: string }> }>> {
  const eligible = sourceAssets.filter((asset) => isEligibleSourceAsset(asset, ownerId));
  const byId = new Map(eligible.map((asset) => [asset.id, asset]));
  const companionIds = new Set<string>();
  if (kind !== "videos") {
    for (const asset of eligible) {
      if (asset.type === AssetTypeEnum.Image && asset.livePhotoVideoId) companionIds.add(asset.livePhotoVideoId);
    }
  }

  const groups: Array<{ primary: AssetResponseDto; components: Array<AssetResponseDto | { id: string; error: string }> }> = [];
  for (const asset of eligible) {
    if (kind !== "photos" && kind !== "videos" && asset.type === AssetTypeEnum.Video && companionIds.has(asset.id)) {
      continue;
    }
    if (kind === "photos" && asset.type !== AssetTypeEnum.Image) continue;
    if (kind === "videos" && asset.type !== AssetTypeEnum.Video) continue;

    const components: Array<AssetResponseDto | { id: string; error: string }> = [asset];
    if (kind !== "videos" && asset.type === AssetTypeEnum.Image && asset.livePhotoVideoId) {
      try {
        components.push(await getLivePhotoVideo(source, byId, ownerId, asset.livePhotoVideoId));
      } catch {
        components.push({ id: asset.livePhotoVideoId, error: "Live Photo companion could not be verified." });
      }
    }
    groups.push({ primary: asset, components });
  }
  return groups;
}

export async function planTransfer(options: TransferPlanOptions): Promise<TransferPlan> {
  validateOptions(options);
  const kind = options.kind ?? "all";
  const [sourceCheck, targetCheck] = await Promise.all([
    checkInstance(options.source),
    checkInstance(options.target),
  ]);
  if (options.metadataSync) {
    validatePermissions("Source", sourceCheck, metadataSyncPermissions("source", options.metadataSync));
    validatePermissions("Target", targetCheck, metadataSyncPermissions("target", options.metadataSync));
  } else {
    validatePreflight("Source", sourceCheck, options.operation === "move" ? "source-move" : "source-copy");
    validatePreflight("Target", targetCheck, "target-copy");
  }

  if (
    normalizedApiUrl(options.source.apiUrl) === normalizedApiUrl(options.target.apiUrl) &&
    sourceCheck.user?.id === targetCheck.user?.id
  ) {
    throw new TransferPlanError("Source and target cannot be the same server and user.");
  }

  let sourceAssets: AssetResponseDto[];
  try {
    sourceAssets = await discoverSourceAssets(options.source, kind, options.range);
  } catch (error) {
    if (error instanceof TransferPlanError) throw error;
    if (error instanceof AssetSearchError) throw new TransferPlanError(error.message);
    throw new TransferPlanError(`Source asset discovery failed for ${options.source.alias} (${safeRequestError(error)}).`);
  }

  const groups = await buildGroups(options.source, sourceAssets, sourceCheck.user!.id, kind);
  const plannedAssets: PlannedAsset[] = [];
  const events: TransferPlanEvent[] = [];
  const warnings = [PREVIEW_WARNING];
  if (sourceCheck.version !== targetCheck.version) {
    warnings.push(`Immich version mismatch: source ${sourceCheck.version}, target ${targetCheck.version}.`);
  }
  for (const message of warnings) events.push({ type: "warning", message });

  for (const group of groups) {
    const components: PlannedComponent[] = [];
    for (const component of group.components) {
      if ("error" in component) {
        components.push({
          id: component.id,
          fileName: "Live Photo companion",
          type: AssetTypeEnum.Video,
          checksum: "",
          sizeBytes: null,
          status: "failed",
          message: component.error,
        });
      } else {
        components.push(await classifyComponent(options.target, component));
      }
    }
    const status = groupStatus(components);
    const planned: PlannedAsset = {
      id: group.primary.id,
      fileName: group.primary.originalFileName,
      type: group.primary.type,
      status,
      components,
    };
    plannedAssets.push(planned);
    const failure = components.find((component) => component.status === "failed")?.message;
    events.push({
      type: "asset",
      id: planned.id,
      fileName: planned.fileName,
      status,
      ...(failure ? { message: failure } : {}),
    });
  }

  const summary = summarize(plannedAssets, options.operation);
  events.push({ type: "summary", summary });
  return {
    kind: "transfer-preview",
    operation: options.operation,
    sourceAlias: options.source.alias,
    targetAlias: options.target.alias,
    sourceVersion: sourceCheck.version!,
    targetVersion: targetCheck.version!,
    warnings,
    assets: plannedAssets,
    summary,
    events,
  };
}