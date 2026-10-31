/**
 * Move execution: copy with target checksum verification, optional partial metadata sync,
 * then trash (never permanently delete) on the source for each fully verified asset.
 */

import { describeHttpError } from "./http-error.ts";
import { deleteAssets } from "@immich/sdk";
import { findAssetsByChecksum } from "./asset-search.ts";
import { copyAssets, type CopyAssetResult, type CopyAssetStatus, type TransferProgress } from "./copy.ts";
import { requestOpts, type Instance } from "./instance.ts";
import { syncMetadataFields, type MetadataFieldAssetResult } from "./metadata-fields.ts";
import { planTransfer, type PlannedAsset, type TransferPlan, type TransferPlanOptions } from "./plan.ts";

export type MoveOptions = Omit<TransferPlanOptions, "operation"> & {
  operation: "move";
  /** When true, a successful partial metadata sync (selected fields only) is required before trashing. */
  metadataSync: boolean;
  /** Passed to metadata sync; additive owned-album membership by exact name. */
  includeAlbums?: boolean;
  /** Passed to metadata sync; requires includeAlbums. */
  createMissingAlbums?: boolean;
  /** Passed to metadata sync; additive tags matched by exact value. */
  includeTags?: boolean;
  /**
   * Called with the verified copies after upload and before metadata sync (only when metadataSync is
   * true). Returns source asset ID -> reason for every asset whose target is not ready; those assets
   * skip metadata sync, are reported as metadata-failed (or cancelled when aborted) and are not trashed.
   * A thrown error fails metadata for all verified assets.
   */
  beforeMetadataSync?: (verified: CopyAssetResult[]) => Promise<ReadonlyMap<string, string>>;
  dryRun?: boolean;
  signal?: AbortSignal;
  /**
   * Called synchronously as each asset reaches its FINAL move outcome (trashed, metadata-failed,
   * trash-failed, in-target-trash, failed, cancelled), in plan order, before moveAssets resolves.
   * Outcomes are final only after copy, metadata sync and the trash decision, so these fire during
   * the finalizing loop (live per trash request), not during the upload phase; use onProgress for
   * upload-phase progress. Never called for dry runs. Contains no credentials; errors are ignored.
   */
  onAsset?: (asset: MoveAssetResult) => void;
  /** "copying" progress per uploaded asset, then "finalizing" progress per finished asset. Errors are ignored. */
  onProgress?: (progress: TransferProgress) => void;
};

export type MoveAssetStatus =
  | "trashed"
  | "metadata-failed"
  | "trash-failed"
  | "in-target-trash"
  | "failed"
  | "cancelled";

export type MoveMetadataStatus = "synced" | "failed" | "not-attempted" | "disabled";

export type MoveAssetResult = {
  id: string;
  fileName: string;
  status: MoveAssetStatus;
  copyStatus: CopyAssetStatus;
  metadataStatus: MoveMetadataStatus;
  /** Source asset IDs (all components) sent to the source trash. */
  trashedIds: string[];
  /** Why the asset was not trashed. */
  reason?: string;
  message?: string;
};

export type MoveSummary = {
  assetsFound: number;
  componentsCopied: number;
  bytesCopied: number;
  alreadyPresent: number;
  copied: number;
  trashed: number;
  notTrashed: number;
  inTargetTrash: number;
  metadataFailed: number;
  trashFailed: number;
  failed: number;
  cancelled: number;
};

export type MoveEvent =
  | { type: "warning"; message: string }
  | { type: "asset"; id: string; fileName: string; status: MoveAssetStatus; reason?: string }
  | { type: "summary"; summary: MoveSummary };

export type MoveResult = {
  kind: "move-run";
  operation: "move";
  sourceAlias: string;
  targetAlias: string;
  sourceVersion: string;
  targetVersion: string;
  warnings: string[];
  assets: MoveAssetResult[];
  summary: MoveSummary;
  events: MoveEvent[];
};

function safeError(error: unknown): string {
  const http = describeHttpError(error);
  if (http) return http;
  return "request failed";
}

export function isVerifiedCopy(asset: CopyAssetResult): boolean {
  return (asset.status === "copied" || asset.status === "already-present") &&
    asset.components.length > 0 &&
    asset.components.every((component) =>
      (component.status === "copied" || component.status === "already-present") &&
      component.checksum !== "" && !!component.targetId
    );
}

/** Fresh checksum lookup right before trashing; every component needs an active target asset. */
async function stillVerified(target: Instance, planned: PlannedAsset): Promise<boolean> {
  for (const component of planned.components) {
    if (!component.checksum) return false;
    const found = await findAssetsByChecksum(target, component.checksum);
    if (!found.some((asset) => !asset.isTrashed)) return false;
  }
  return true;
}

export async function moveAssets(options: MoveOptions): Promise<TransferPlan | MoveResult> {
  if (options.operation !== "move") throw new Error("moveAssets only supports operation 'move'.");
  if (typeof options.metadataSync !== "boolean") throw new Error("moveAssets requires an explicit metadataSync boolean.");

  const planOptions: TransferPlanOptions = {
    source: options.source,
    target: options.target,
    operation: "move",
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.range ? { range: options.range } : {}),
  };
  // Validates instances, source-move permission and same-server refusal; read-only.
  const plan = await planTransfer(planOptions);
  if (options.dryRun) return plan;

  let lastCopyProgress: TransferProgress = {
    phase: "copying",
    assetsDone: 0,
    assetsTotal: plan.assets.length,
    bytesDone: 0,
    bytesTotal: 0,
    unknownSizeComponents: 0,
  };
  const copy = await copyAssets({
    source: options.source,
    target: options.target,
    operation: "copy",
    metadataSync: false,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.range ? { range: options.range } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    onProgress: (progress) => {
      lastCopyProgress = progress;
      try {
        options.onProgress?.(progress);
      } catch {
        // A failing listener must not affect the run.
      }
    },
  });
  if (copy.kind !== "copy-run") throw new Error("Unexpected copy result.");
  const signal = options.signal;
  const plannedById = new Map(plan.assets.map((asset) => [asset.id, asset]));
  const copyById = new Map(copy.assets.map((asset) => [asset.id, asset]));

  const verified = copy.assets.filter(isVerifiedCopy);
  const metadataById = new Map<string, MetadataFieldAssetResult>();
  let metadataError: string | undefined;
  let notReady = new Map<string, string>();
  if (options.metadataSync && verified.length > 0 && !signal?.aborted) {
    try {
      if (options.beforeMetadataSync) notReady = new Map(await options.beforeMetadataSync(verified));
      const ready = verified.filter((asset) => !notReady.has(asset.id));
      if (ready.length > 0 && !signal?.aborted) {
        const metadata = await syncMetadataFields({
          source: options.source,
          target: options.target,
          assetIds: ready.map((asset) => asset.id),
          ...(options.includeAlbums ? { includeAlbums: true } : {}),
          ...(options.createMissingAlbums ? { createMissingAlbums: true } : {}),
          ...(options.includeTags ? { includeTags: true } : {}),
          ...(signal ? { signal } : {}),
        });
        for (const asset of metadata.assets) metadataById.set(asset.id, asset);
      }
    } catch (error) {
      metadataError = error instanceof Error ? error.message : safeError(error);
    }
  }

  const assets: MoveAssetResult[] = [];
  const record = (result: MoveAssetResult) => {
    assets.push(result);
    try {
      options.onAsset?.(result);
    } catch {
      // A failing listener must not affect the run.
    }
    try {
      options.onProgress?.({
        ...lastCopyProgress,
        phase: "finalizing",
        assetsDone: assets.length,
        assetsTotal: plan.assets.length,
      });
    } catch {
      // A failing listener must not affect the run.
    }
  };
  for (const planned of plan.assets) {
    const copied = copyById.get(planned.id);
    const base = { id: planned.id, fileName: planned.fileName, trashedIds: [] as string[] };
    if (!copied) {
      record({ ...base, status: "failed", copyStatus: "failed", metadataStatus: "not-attempted", reason: "Asset was not processed by copy." });
      continue;
    }
    const copyStatus = copied.status;
    const notTrashed = (
      status: MoveAssetStatus,
      metadataStatus: MoveMetadataStatus,
      reason: string,
    ): MoveAssetResult => ({ ...base, status, copyStatus, metadataStatus, reason, ...(copied.message ? { message: copied.message } : {}) });
    const disabled: MoveMetadataStatus = options.metadataSync ? "not-attempted" : "disabled";

    if (copyStatus === "in-target-trash") {
      record(notTrashed("in-target-trash", disabled, "Found in target trash; skipped and not trashed on source."));
      continue;
    }
    if (copyStatus === "cancelled") {
      record(notTrashed("cancelled", disabled, "Cancelled before target verification; not trashed."));
      continue;
    }
    if (!isVerifiedCopy(copied)) {
      record(notTrashed("failed", disabled, "Not verified on the target; not trashed."));
      continue;
    }

    let metadataStatus: MoveMetadataStatus = "disabled";
    const notReadyReason = options.metadataSync ? notReady.get(planned.id) : undefined;
    if (notReadyReason !== undefined) {
      record(signal?.aborted
        ? notTrashed("cancelled", "not-attempted", "Cancelled while waiting for target metadata; not trashed.")
        : notTrashed("metadata-failed", "failed", `Target metadata was not ready (${notReadyReason}); not trashed.`));
      continue;
    }
    if (options.metadataSync) {
      const metadata = metadataById.get(planned.id);
      if (metadata && (metadata.status === "updated" || metadata.status === "already-synced")) {
        metadataStatus = "synced";
      } else if (!metadata && !metadataError && signal?.aborted) {
        record(notTrashed("cancelled", "not-attempted", "Cancelled before metadata sync; not trashed."));
        continue;
      } else if (metadata?.status === "cancelled") {
        record(notTrashed("cancelled", "not-attempted", "Cancelled during metadata sync; not trashed."));
        continue;
      } else {
        const detail = metadata?.message ?? metadataError ?? metadata?.status ?? "no result";
        record(notTrashed("metadata-failed", "failed", `Metadata sync did not succeed (${detail}); not trashed.`));
        continue;
      }
    }

    if (signal?.aborted) {
      record(notTrashed("cancelled", metadataStatus, "Cancelled before trashing; verified on target, rerun to finish the move."));
      continue;
    }

    try {
      if (!(await stillVerified(options.target, plannedById.get(planned.id)!))) {
        record(notTrashed("failed", metadataStatus, "Target verification failed immediately before trashing; not trashed."));
        continue;
      }
    } catch (error) {
      record(notTrashed("failed", metadataStatus, `Target verification before trashing failed (${safeError(error)}); not trashed.`));
      continue;
    }

    const ids = planned.components.map((component) => component.id);
    try {
      // Trash only: force is always false, so Immich moves assets to trash instead of deleting.
      await deleteAssets({ assetBulkDeleteDto: { ids, force: false } }, requestOpts(options.source));
      record({ ...base, trashedIds: ids, status: "trashed", copyStatus, metadataStatus });
    } catch (error) {
      record(notTrashed("trash-failed", metadataStatus, `Source trash request failed (${safeError(error)}); asset remains on source.`));
    }
  }

  const count = (status: MoveAssetStatus) => assets.filter((asset) => asset.status === status).length;
  const summary: MoveSummary = {
    assetsFound: assets.length,
    componentsCopied: copy.summary.componentsCopied,
    bytesCopied: copy.summary.bytesCopied,
    alreadyPresent: copy.summary.alreadyPresent,
    copied: copy.summary.assetsCopied,
    trashed: count("trashed"),
    notTrashed: assets.length - count("trashed"),
    inTargetTrash: count("in-target-trash"),
    metadataFailed: count("metadata-failed"),
    trashFailed: count("trash-failed"),
    failed: count("failed"),
    cancelled: count("cancelled"),
  };
  const warnings = [
    ...plan.warnings.filter((message) => !message.includes("No files are uploaded or trashed.")),
    options.metadataSync
      ? "Metadata sync covers selected fields only (favorite, visibility, description, rating, GPS, optional albums); it does not cover the full SPEC metadata set."
      : "Metadata sync is disabled; assets are trashed on the source after target verification only.",
    "Source assets are only moved to the source trash, never permanently deleted.",
  ];
  const events: MoveEvent[] = [
    ...warnings.map((message) => ({ type: "warning" as const, message })),
    ...assets.map((asset) => ({
      type: "asset" as const,
      id: asset.id,
      fileName: asset.fileName,
      status: asset.status,
      ...(asset.reason ? { reason: asset.reason } : {}),
    })),
    { type: "summary", summary },
  ];
  return {
    kind: "move-run",
    operation: "move",
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
