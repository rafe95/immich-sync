import { describeHttpError } from "./http-error.ts";
import {
  AssetTypeEnum,
  AssetVisibility,
  getAssetInfo,
  type AssetResponseDto,
} from "@immich/sdk";
import { findAssetsByChecksum } from "./asset-search.ts";
import { checkInstance } from "./check.ts";
import { downloadOriginal, uploadOriginal } from "./media-stream.ts";
import { planTransfer, type PlannedAsset, type PlannedComponent, type TransferPlan, type TransferPlanOptions } from "./plan.ts";
import { requestOpts, type Instance } from "./instance.ts";

export type CopyOptions = Omit<TransferPlanOptions, "operation"> & {
  operation: "copy";
  /** Metadata synchronization is intentionally not implemented in this copy increment. */
  metadataSync: false;
  dryRun?: boolean;
  signal?: AbortSignal;
  /**
   * Called synchronously as each asset finishes (copied, already-present, in-target-trash, failed or
   * cancelled), in plan order, before copyAssets resolves. Never called for dry runs. Contains no
   * credentials. Errors thrown by it are ignored.
   */
  onAsset?: (asset: CopyAssetResult) => void;
  /** Called after each asset finishes (same moment as onAsset) with running totals. Errors are ignored. */
  onProgress?: (progress: TransferProgress) => void;
};

/**
 * Progress of a transfer for a progress bar. Bytes count original files of copied components; the
 * total covers only components whose size the source reported (unknownSizeComponents counts the rest)
 * and only components that were planned to be transferred.
 */
export type TransferProgress = {
  phase: "copying" | "finalizing";
  assetsDone: number;
  assetsTotal: number;
  bytesDone: number;
  bytesTotal: number;
  unknownSizeComponents: number;
};

export type CopyComponentStatus = "copied" | "already-present" | "in-target-trash" | "failed" | "cancelled";
export type CopyAssetStatus = "copied" | "already-present" | "in-target-trash" | "failed" | "cancelled";

export type CopyComponentResult = {
  id: string;
  fileName: string;
  checksum: string;
  status: CopyComponentStatus;
  targetId?: string;
  message?: string;
};

export type CopyAssetResult = {
  id: string;
  fileName: string;
  status: CopyAssetStatus;
  components: CopyComponentResult[];
  message?: string;
};

export type CopySummary = {
  assetsFound: number;
  componentsCopied: number;
  assetsCopied: number;
  alreadyPresent: number;
  inTargetTrash: number;
  failed: number;
  cancelled: number;
  bytesCopied: number;
};

export type CopyEvent =
  | { type: "warning"; message: string }
  | { type: "asset"; id: string; fileName: string; status: CopyAssetStatus; message?: string }
  | { type: "summary"; summary: CopySummary };

export type CopyResult = {
  kind: "copy-run";
  operation: "copy";
  sourceAlias: string;
  targetAlias: string;
  sourceVersion: string;
  targetVersion: string;
  warnings: string[];
  assets: CopyAssetResult[];
  summary: CopySummary;
  events: CopyEvent[];
};

type TargetState = { active: AssetResponseDto | null; trashed: boolean };

function safeError(error: unknown): string {
  const http = describeHttpError(error);
  if (http) return http;
  return "request failed";
}

function targetState(assets: AssetResponseDto[]): TargetState {
  const active = assets.find((asset) => !asset.isTrashed) ?? null;
  return {
    active,
    trashed: !active && assets.some((asset) => asset.isTrashed),
  };
}

function componentResult(
  component: PlannedComponent,
  status: CopyComponentStatus,
  details: { targetId?: string; message?: string } = {},
): CopyComponentResult {
  return {
    id: component.id,
    fileName: component.fileName,
    checksum: component.checksum,
    status,
    ...details,
  };
}

function groupResult(
  asset: PlannedAsset,
  components: CopyComponentResult[],
  message?: string,
): CopyAssetResult {
  const resultMessage = message ?? components.find((component) => component.message)?.message;
  const status: CopyAssetStatus = components.some((component) => component.status === "cancelled")
    ? "cancelled"
    : components.some((component) => component.status === "failed")
      ? "failed"
      : components.some((component) => component.status === "in-target-trash")
        ? "in-target-trash"
        : components.some((component) => component.status === "copied")
          ? "copied"
          : "already-present";
  return {
    id: asset.id,
    fileName: asset.fileName,
    status,
    components,
    ...(resultMessage ? { message: resultMessage } : {}),
  };
}

function summarize(assets: CopyAssetResult[], plannedAssets: PlannedAsset[]): CopySummary {
  const copiedComponents = assets.flatMap((asset) => asset.components).filter((component) => component.status === "copied");
  const sizes = new Map(
    plannedAssets.flatMap((asset) => asset.components.map((component) => [component.id, component.sizeBytes] as const)),
  );
  return {
    assetsFound: assets.length,
    componentsCopied: copiedComponents.length,
    assetsCopied: assets.filter((asset) => asset.status === "copied").length,
    alreadyPresent: assets.filter((asset) => asset.status === "already-present").length,
    inTargetTrash: assets.filter((asset) => asset.status === "in-target-trash").length,
    failed: assets.filter((asset) => asset.status === "failed").length,
    cancelled: assets.filter((asset) => asset.status === "cancelled").length,
    bytesCopied: copiedComponents.reduce((total, component) => total + (sizes.get(component.id) ?? 0), 0),
  };
}

async function findTargetState(
  target: Instance,
  component: PlannedComponent,
  signal?: AbortSignal,
): Promise<TargetState> {
  return targetState(await findAssetsByChecksum(target, component.checksum, signal));
}

async function getSourceAsset(
  source: Instance,
  component: PlannedComponent,
  ownerId: string,
  signal?: AbortSignal,
): Promise<AssetResponseDto> {
  const asset = await getAssetInfo({ id: component.id }, { ...requestOpts(source), signal });
  if (
    asset.id !== component.id ||
    asset.checksum !== component.checksum ||
    asset.ownerId !== ownerId ||
    asset.isTrashed ||
    (asset.visibility !== AssetVisibility.Timeline && asset.visibility !== AssetVisibility.Archive) ||
    asset.type !== component.type ||
    typeof asset.originalFileName !== "string" ||
    !asset.originalFileName.trim() ||
    !Number.isFinite(Date.parse(asset.fileCreatedAt)) ||
    !Number.isFinite(Date.parse(asset.fileModifiedAt))
  ) {
    throw new Error("Source asset changed, is no longer eligible, or lacks required upload fields.");
  }
  return asset;
}

function orderedComponents(components: PlannedComponent[]): PlannedComponent[] {
  return [...components].sort((left, right) => {
    if (left.type === AssetTypeEnum.Video && right.type === AssetTypeEnum.Image) return -1;
    if (left.type === AssetTypeEnum.Image && right.type === AssetTypeEnum.Video) return 1;
    return 0;
  });
}

function failedGroup(asset: PlannedAsset, message: string): CopyAssetResult {
  return groupResult(
    asset,
    asset.components.map((component) => componentResult(component, "failed", { message })),
    message,
  );
}

async function copyAssetGroup(
  source: Instance,
  target: Instance,
  asset: PlannedAsset,
  ownerId: string,
  signal?: AbortSignal,
): Promise<CopyAssetResult> {
  if (asset.components.some((component) => !component.checksum)) {
    return failedGroup(asset, "A source component has no verifiable checksum.");
  }

  const states = new Map<string, TargetState>();
  try {
    for (const component of asset.components) {
      states.set(component.id, await findTargetState(target, component, signal));
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return failedGroup(asset, `Fresh target checksum lookup failed (${safeError(error)}).`);
  }

  if (asset.components.some((component) => states.get(component.id)?.trashed)) {
    return groupResult(
      asset,
      asset.components.map((component) => {
        const state = states.get(component.id)!;
        return componentResult(component, state.trashed ? "in-target-trash" : "already-present", {
          ...(state.active ? { targetId: state.active.id } : {}),
          ...(state.trashed ? { message: "Matching checksum exists in target trash; it will not be re-uploaded." } : {}),
        });
      }),
      "At least one component is in target trash; this logical asset was not copied.",
    );
  }

  const photo = asset.components.find((component) => component.type === AssetTypeEnum.Image);
  const video = asset.components.find((component) => component.type === AssetTypeEnum.Video);
  const targetPhoto = photo ? states.get(photo.id)?.active : undefined;
  const targetVideo = video ? states.get(video.id)?.active : undefined;
  if (photo && video && targetPhoto && (!targetVideo || targetPhoto.livePhotoVideoId !== targetVideo.id)) {
    return failedGroup(asset, "The target has an unpaired Live Photo image; pairing metadata is not repaired by copy.");
  }

  const outcomes = new Map<string, CopyComponentResult>();
  for (const component of asset.components) {
    const active = states.get(component.id)?.active;
    if (active) outcomes.set(component.id, componentResult(component, "already-present", { targetId: active.id }));
  }

  for (const component of orderedComponents(asset.components)) {
    if (outcomes.has(component.id)) continue;
    if (signal?.aborted) {
      outcomes.set(component.id, componentResult(component, "cancelled", { message: "Copy cancelled before this component started." }));
      continue;
    }

    try {
      const sourceAsset = await getSourceAsset(source, component, ownerId, signal);
      let livePhotoVideoId: string | undefined;
      if (component.type === AssetTypeEnum.Image && video) {
        if (sourceAsset.livePhotoVideoId !== video.id) {
          throw new Error("Source Live Photo pairing changed after planning.");
        }
        livePhotoVideoId = outcomes.get(video.id)?.targetId;
        if (!livePhotoVideoId) throw new Error("Verified target Live Photo video is unavailable.");
      }
      const stream = await downloadOriginal(source, component.id, signal);
      await uploadOriginal(target, {
        asset: sourceAsset,
        checksum: component.checksum,
        stream,
        ...(livePhotoVideoId ? { livePhotoVideoId } : {}),
        signal,
      });
      const verified = targetState(await findAssetsByChecksum(target, component.checksum, signal)).active;
      if (!verified) {
        throw new Error("Target checksum verification did not find an active uploaded asset.");
      }
      outcomes.set(component.id, componentResult(component, "copied", { targetId: verified.id }));
    } catch (error) {
      if (signal?.aborted) {
        outcomes.set(component.id, componentResult(component, "cancelled", { message: "Copy cancelled before checksum verification." }));
        for (const remaining of asset.components) {
          if (!outcomes.has(remaining.id)) {
            outcomes.set(remaining.id, componentResult(remaining, "cancelled", { message: "Copy cancelled before this component started." }));
          }
        }
        break;
      }
      const message = error instanceof Error &&
          error.message === "Source asset changed, is no longer eligible, or lacks required upload fields."
        ? error.message
        : `Component copy failed (${safeError(error)}).`;
      outcomes.set(component.id, componentResult(component, "failed", { message }));
      for (const remaining of asset.components) {
        if (!outcomes.has(remaining.id)) {
          outcomes.set(remaining.id, componentResult(remaining, "failed", { message: "Not attempted after another component failed." }));
        }
      }
      break;
    }
  }

  return groupResult(asset, asset.components.map((component) => outcomes.get(component.id)!));
}

export async function copyAssets(options: CopyOptions): Promise<TransferPlan | CopyResult> {
  if (options.operation !== "copy") throw new Error("copyAssets only supports operation 'copy'.");
  if (options.metadataSync !== false) throw new Error("copyAssets requires metadataSync: false; metadata synchronization is not implemented.");

  const planOptions: TransferPlanOptions = {
    source: options.source,
    target: options.target,
    operation: "copy",
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.range ? { range: options.range } : {}),
    ...(options.includeTrashed ? { includeTrashed: true } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  // Cancelling while the plan is built rejects with the signal's reason: there is no plan to report results against.
  const plan = await planTransfer(planOptions);
  if (options.dryRun) return plan;

  const sourceCheck = await checkInstance(options.source);
  if (!sourceCheck.ok || !sourceCheck.user?.id) {
    const assets = plan.assets.map((asset) => failedGroup(asset, "Source preflight changed after planning; no copy was attempted."));
    return createCopyResult(plan, assets);
  }

  const warnings = [
    ...plan.warnings.filter((message) => !message.includes("No files are uploaded or trashed.")),
    "Metadata changes are not compared or synchronized by this copy operation.",
    "Source assets are never trashed by copy.",
  ];
  const assets: CopyAssetResult[] = [];
  const toTransfer = plan.assets
    .filter((asset) => asset.status === "would-transfer")
    .flatMap((asset) => asset.components)
    .filter((component) => component.status === "would-transfer");
  const bytesTotal = toTransfer.reduce((total, component) => total + (component.sizeBytes ?? 0), 0);
  const unknownSizeComponents = toTransfer.filter((component) => component.sizeBytes === null).length;
  const sizes = new Map(plan.assets.flatMap((asset) => asset.components.map((c) => [c.id, c.sizeBytes ?? 0] as const)));
  let bytesDone = 0;
  const record = (result: CopyAssetResult) => {
    assets.push(result);
    for (const component of result.components) {
      if (component.status === "copied") bytesDone += sizes.get(component.id) ?? 0;
    }
    try {
      options.onAsset?.(result);
    } catch {
      // A failing listener must not affect the run.
    }
    try {
      options.onProgress?.({
        phase: "copying",
        assetsDone: assets.length,
        assetsTotal: plan.assets.length,
        bytesDone,
        bytesTotal,
        unknownSizeComponents,
      });
    } catch {
      // A failing listener must not affect the run.
    }
  };
  for (const planned of plan.assets) {
    if (options.signal?.aborted) {
      record(groupResult(
        planned,
        planned.components.map((component) => componentResult(component, "cancelled", { message: "Copy cancelled before this asset started." })),
      ));
      continue;
    }
    try {
      record(await copyAssetGroup(options.source, options.target, planned, sourceCheck.user.id, options.signal));
    } catch (error) {
      if (!options.signal?.aborted) throw error;
      record(groupResult(
        planned,
        planned.components.map((component) => componentResult(component, "cancelled", { message: "Copy cancelled before this asset completed." })),
      ));
    }
  }
  return createCopyResult(plan, assets, warnings);
}

function createCopyResult(plan: TransferPlan, assets: CopyAssetResult[], warnings = plan.warnings): CopyResult {
  const summary = summarize(assets, plan.assets);
  const events: CopyEvent[] = warnings.map((message) => ({ type: "warning", message }));
  for (const asset of assets) {
    events.push({
      type: "asset",
      id: asset.id,
      fileName: asset.fileName,
      status: asset.status,
      ...(asset.message ? { message: asset.message } : {}),
    });
  }
  events.push({ type: "summary", summary });
  return {
    kind: "copy-run",
    operation: "copy",
    sourceAlias: plan.sourceAlias,
    targetAlias: plan.targetAlias,
    sourceVersion: plan.sourceVersion,
    targetVersion: plan.targetVersion,
    warnings,
    assets,
    summary,
    events,
  };
}