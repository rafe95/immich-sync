/**
 * Step runner: one entry point for a job step (copy, move or sync_metadata) that normalizes options,
 * results and events so the backend can persist them. It composes planTransfer, copyAssets,
 * moveAssets and syncMetadataFields; it adds the metadata wait (after upload, before metadata sync),
 * an upfront metadata preflight, and a normalized result. It never throws for run-level problems:
 * those are reported as status "error".
 */

import { describeHttpError } from "./http-error.ts";
import { getAssetInfo, isHttpError } from "@immich/sdk";
import { AssetSearchError } from "./asset-search.ts";
import { copyAssets, type CopyAssetResult, type CopyOptions, type TransferProgress } from "./copy.ts";
import { requestOpts, type Instance } from "./instance.ts";
import {
  MetadataFieldsError,
  preflightMetadataFields,
  syncMetadataFields,
  type MetadataFieldAssetResult,
} from "./metadata-fields.ts";
import { isVerifiedCopy, moveAssets, type MoveAssetResult } from "./move.ts";
import { planTransfer, TransferPlanError, type TransferPlan } from "./plan.ts";

export type StepOperation = "copy" | "move" | "sync_metadata";
export type StepStatus = "completed" | "completed_with_failures" | "error" | "cancelled";

export type StepAssetOutcome =
  | "copied"
  | "moved"
  | "synced"
  | "unchanged"
  | "skipped"
  | "in-target-trash"
  | "failed"
  | "cancelled"
  | "would-copy"
  | "would-move"
  | "would-sync";

export type StepTransferStatus =
  | "copied"
  | "already-present"
  | "not-on-target"
  | "would-transfer"
  | "in-target-trash"
  | "failed"
  | "cancelled";

export type StepMetadataStatus =
  | "synced"
  | "unchanged"
  | "would-update"
  | "failed"
  | "cancelled"
  | "not-attempted"
  | "disabled";

export type StepAssetResult = {
  id: string;
  fileName: string;
  outcome: StepAssetOutcome;
  transfer: StepTransferStatus;
  metadata: StepMetadataStatus;
  /** True only when the source asset was sent to the source trash (move). */
  trashed: boolean;
  changedFields?: string[];
  message?: string;
};

export type StepSummary = {
  assetsFound: number;
  copied: number;
  moved: number;
  synced: number;
  unchanged: number;
  skipped: number;
  inTargetTrash: number;
  failed: number;
  cancelled: number;
  wouldCopy: number;
  wouldMove: number;
  wouldSync: number;
  bytesCopied: number;
  bytesToTransfer: number;
};

export type StepPhase = "preflight" | "running" | "metadata-wait";

/**
 * copying: uploads (bytes known); metadata: target-metadata sync of assets; finalizing: move outcomes
 * (trash decisions) per asset.
 */
export type StepProgressPhase = "copying" | "metadata" | "finalizing";

export type StepEvent =
  | { type: "phase"; phase: StepPhase; message: string }
  /** done/total count assets; bytes are present for "copying" (total covers components with a known size only). */
  | { type: "progress"; phase: StepProgressPhase; done: number; total: number; bytesDone?: number; bytesTotal?: number }
  | { type: "warning"; message: string }
  | { type: "asset"; asset: StepAssetResult }
  | { type: "error"; message: string }
  | { type: "summary"; status: StepStatus; summary: StepSummary };

export type MetadataWaitOptions = {
  /** Overall bound for the wait (default 120000 ms). */
  timeoutMs?: number;
  /** First poll delay (default 500 ms); doubles each round. */
  initialDelayMs?: number;
  /** Upper bound of the backoff delay (default 5000 ms). */
  maxDelayMs?: number;
  /** Injectable delay; must resolve (not reject) when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable clock in ms. */
  now?: () => number;
};

export type StepOptions = {
  source: Instance;
  target: Instance;
  operation: StepOperation;
  range?: { from?: string; to?: string };
  /** Also consider assets in the source's trash (copy and sync_metadata only). The target's trash is never affected. */
  includeTrashed?: boolean;
  kind?: "all" | "photos" | "videos";
  /** copy/move: also sync metadata fields. Implied (and required) for sync_metadata. Default false. */
  metadata?: boolean;
  includeAlbums?: boolean;
  createMissingAlbums?: boolean;
  includeTags?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
  /**
   * Called synchronously for every event as it is produced; errors thrown by it are ignored. Asset
   * events are delivered live, while the engine runs, as each asset reaches its final outcome (always
   * in the same order as result.assets, never twice). For copy with metadata and for move the final
   * outcome depends on later phases, so those events arrive when the metadata/trash phase reaches the
   * asset; progress events cover the earlier upload phase. Dry runs deliver asset events at the end
   * (sync_metadata dry runs deliver them live).
   */
  onEvent?: (event: StepEvent) => void;
  metadataWait?: MetadataWaitOptions;
};

export type StepResult = {
  kind: "step-run";
  operation: StepOperation;
  dryRun: boolean;
  status: StepStatus;
  sourceAlias: string;
  targetAlias: string;
  sourceVersion?: string;
  targetVersion?: string;
  warnings: string[];
  assets: StepAssetResult[];
  summary: StepSummary;
  events: StepEvent[];
  /** Set when status is "error". Never contains credentials. */
  error?: string;
};

type Engine = {
  assets: StepAssetResult[];
  warnings: string[];
  sourceVersion: string;
  targetVersion: string;
  bytesCopied: number;
  bytesToTransfer: number;
};

/** Live delivery hooks handed to the engines. */
type Live = {
  emit: (event: StepEvent) => void;
  asset: (asset: StepAssetResult) => void;
  progress: (phase: StepProgressPhase, done: number, total: number, bytesDone?: number, bytesTotal?: number) => void;
};

/** Emits assets in `order` as soon as every earlier one is known, so live events match result order. */
function sequence(order: string[], live: Live) {
  const ready = new Map<string, StepAssetResult>();
  let next = 0;
  return (id: string, asset: StepAssetResult) => {
    if (ready.has(id)) return;
    ready.set(id, asset);
    while (next < order.length && ready.has(order[next]!)) live.asset(ready.get(order[next++]!)!);
  };
}

type StepMetadata = { status: StepMetadataStatus; changedFields?: string[]; message?: string };

const PREVIEW_MARKER = "No files are uploaded or trashed.";
const DRY_RUN_WARNING = "Dry run: no changes were made on either server.";
const LIVE_PHOTO_NOTE = "Metadata sync applies to the primary asset only; Live Photo companion videos are not synchronized.";

function safeMessage(error: unknown): string {
  if (error instanceof TransferPlanError || error instanceof MetadataFieldsError || error instanceof AssetSearchError) {
    return error.message;
  }
  const http = describeHttpError(error);
  if (http) return http;
  return "Step failed unexpectedly.";
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Waits until the target has read the metadata of newly uploaded primary assets. Immich creates the
 * asset's exif record in its metadata extraction job, so `exifInfo` is absent from the asset until
 * then; presence of `exifInfo` is the readiness signal (not yet verified against a live server).
 * Returns source asset ID -> reason for every asset not ready (timeout, trashed, missing, cancelled).
 * Already-present assets are not waited on.
 */
export async function waitForTargetMetadata(
  target: Instance,
  assets: CopyAssetResult[],
  options: MetadataWaitOptions = {},
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  let delay = options.initialDelayMs ?? 500;

  const pending = new Map<string, string>();
  for (const asset of assets) {
    const primary = asset.components.find((component) => component.id === asset.id);
    if (primary?.status === "copied" && primary.targetId) pending.set(asset.id, primary.targetId);
  }
  const failures = new Map<string, string>();
  const notes = new Map<string, string>();
  const start = now();

  while (pending.size > 0) {
    if (signal?.aborted) {
      for (const id of pending.keys()) failures.set(id, "cancelled while waiting for target metadata");
      break;
    }
    for (const [id, targetId] of [...pending]) {
      if (signal?.aborted) break;
      try {
        const info = await getAssetInfo({ id: targetId }, { ...requestOpts(target), signal });
        if (info.isTrashed) {
          failures.set(id, "target asset was trashed while waiting");
          pending.delete(id);
        } else if (info.exifInfo) {
          pending.delete(id);
        }
      } catch (error) {
        if (signal?.aborted) break;
        if (isHttpError(error) && error.status === 404) {
          failures.set(id, "target asset disappeared while waiting");
          pending.delete(id);
        } else {
          notes.set(id, safeMessage(error));
        }
      }
    }
    if (pending.size === 0 || signal?.aborted) continue;
    const elapsed = now() - start;
    if (elapsed >= timeoutMs) {
      for (const id of pending.keys()) {
        const note = notes.get(id);
        failures.set(id, `timed out after ${timeoutMs} ms waiting for the target to read file metadata${note ? ` (last error: ${note})` : ""}`);
      }
      break;
    }
    await sleep(Math.min(delay, timeoutMs - elapsed), signal);
    delay = Math.min(delay * 2, maxDelayMs);
  }
  return failures;
}

function fromFields(result: MetadataFieldAssetResult): StepMetadata {
  const changedFields = [
    ...result.changedFields,
    ...(result.changedFields.includes("albums") ? [] : result.changedAlbums.length ? ["albums"] : []),
  ];
  const base = { ...(changedFields.length ? { changedFields } : {}), ...(result.message ? { message: result.message } : {}) };
  switch (result.status) {
    case "updated": return { status: "synced", ...base };
    case "already-synced": return { status: "unchanged", ...base };
    case "would-update": return { status: "would-update", ...base };
    case "cancelled": return { status: "cancelled", ...base };
    case "in-target-trash":
      return { status: "failed", message: "Target asset is in the trash; metadata was not synchronized." };
    default: return { status: "failed", ...base };
  }
}

type MetaFlags = Pick<StepOptions, "includeAlbums" | "createMissingAlbums" | "includeTags">;

function metaFlags(options: StepOptions): MetaFlags {
  return {
    ...(options.includeAlbums ? { includeAlbums: true } : {}),
    ...(options.createMissingAlbums ? { createMissingAlbums: true } : {}),
    ...(options.includeTags ? { includeTags: true } : {}),
  };
}

/** Runs syncMetadataFields for the given source IDs; a run-level failure fails every ID. */
async function syncIds(
  options: StepOptions,
  ids: string[],
  dryRun: boolean,
  onResult?: (id: string, result: StepMetadata) => void,
): Promise<{ results: Map<string, StepMetadata>; warnings: string[] }> {
  const results = new Map<string, StepMetadata>();
  if (ids.length === 0) return { results, warnings: [] };
  try {
    const run = await syncMetadataFields({
      source: options.source,
      target: options.target,
      assetIds: ids,
      ...metaFlags(options),
      ...(dryRun ? { dryRun: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(onResult ? { onAsset: (asset: MetadataFieldAssetResult) => onResult(asset.id, fromFields(asset)) } : {}),
    });
    for (const asset of run.assets) results.set(asset.id, fromFields(asset));
    return { results, warnings: run.warnings };
  } catch (error) {
    for (const id of ids) results.set(id, { status: "failed", message: safeMessage(error) });
    return { results, warnings: [] };
  }
}

function planNotes(plan: TransferPlan): string[] {
  return plan.warnings.filter((message) => !message.includes(PREVIEW_MARKER));
}

function planFailure(asset: TransferPlan["assets"][number]): string | undefined {
  return asset.components.find((component) => component.message)?.message;
}

/** Dry-run metadata comparison; possible only for assets already on the target. */
async function compareAlreadyPresent(options: StepOptions, plan: TransferPlan) {
  const ids = plan.assets.filter((asset) => asset.status === "already-present").map((asset) => asset.id);
  return syncIds(options, ids, true);
}

function mapPlan(
  plan: TransferPlan,
  operation: "copy" | "move",
  meta: Map<string, StepMetadata>,
  metadataEnabled: boolean,
): StepAssetResult[] {
  return plan.assets.map((asset): StepAssetResult => {
    const base = { id: asset.id, fileName: asset.fileName, trashed: false };
    const m = meta.get(asset.id);
    const metadata: StepMetadataStatus = !metadataEnabled ? "disabled" : (m?.status ?? "not-attempted");
    const extra = {
      ...(m?.changedFields ? { changedFields: m.changedFields } : {}),
      ...(m?.message ? { message: m.message } : {}),
    };
    switch (asset.status) {
      case "would-transfer":
        return { ...base, outcome: operation === "move" ? "would-move" : "would-copy", transfer: "would-transfer", metadata };
      case "in-target-trash":
        return { ...base, outcome: "in-target-trash", transfer: "in-target-trash", metadata, message: "Found in target trash; skipped." };
      case "failed":
        return { ...base, outcome: "failed", transfer: "failed", metadata, message: planFailure(asset) ?? "Planning failed." };
      default:
        if (operation === "move") return { ...base, outcome: "would-move", transfer: "already-present", metadata, ...extra };
        if (m?.status === "would-update") return { ...base, outcome: "would-sync", transfer: "already-present", metadata, ...extra };
        if (m?.status === "failed") return { ...base, outcome: "failed", transfer: "already-present", metadata, ...extra };
        return { ...base, outcome: "skipped", transfer: "already-present", metadata, ...extra };
    }
  });
}

function mapCopy(asset: CopyAssetResult, meta: StepMetadata | undefined, enabled: boolean, aborted: boolean): StepAssetResult {
  const base = { id: asset.id, fileName: asset.fileName, trashed: false };
  const msg = asset.message ? { message: asset.message } : {};
  if (asset.status === "in-target-trash") {
    return { ...base, outcome: "in-target-trash", transfer: "in-target-trash", metadata: enabled ? "not-attempted" : "disabled", ...msg };
  }
  if (asset.status === "cancelled" || asset.status === "failed") {
    return { ...base, outcome: asset.status, transfer: asset.status, metadata: enabled ? "not-attempted" : "disabled", ...msg };
  }
  const transfer = asset.status; // copied | already-present
  if (!enabled) {
    return { ...base, outcome: transfer === "copied" ? "copied" : "skipped", transfer, metadata: "disabled", ...msg };
  }
  const fields = meta?.changedFields ? { changedFields: meta.changedFields } : {};
  if (!meta || meta.status === "cancelled" || meta.status === "not-attempted") {
    return { ...base, outcome: aborted || meta ? "cancelled" : "failed", transfer, metadata: meta?.status ?? "not-attempted", message: meta?.message ?? "Cancelled before metadata sync." };
  }
  if (meta.status === "failed") {
    return { ...base, outcome: "failed", transfer, metadata: "failed", message: `Metadata sync did not succeed (${meta.message ?? "unknown"}).` };
  }
  const outcome: StepAssetOutcome = transfer === "copied" ? "copied" : meta.status === "synced" ? "synced" : "skipped";
  return { ...base, outcome, transfer, metadata: meta.status, ...fields, ...(meta.message ? { message: meta.message } : {}) };
}

function mapMove(asset: MoveAssetResult): StepAssetResult {
  const outcome: StepAssetOutcome = asset.status === "trashed"
    ? "moved"
    : asset.status === "in-target-trash" || asset.status === "cancelled"
      ? asset.status
      : "failed";
  const metadata: StepMetadataStatus = asset.metadataStatus === "synced"
    ? "synced"
    : asset.metadataStatus === "failed" ? "failed" : asset.metadataStatus === "disabled" ? "disabled" : "not-attempted";
  const message = [asset.reason, asset.message && asset.message !== asset.reason ? asset.message : undefined]
    .filter(Boolean).join(" ");
  return {
    id: asset.id,
    fileName: asset.fileName,
    outcome,
    transfer: asset.copyStatus,
    metadata,
    trashed: asset.status === "trashed",
    ...(message ? { message } : {}),
  };
}

async function runCopy(options: StepOptions, metadata: boolean, live: Live): Promise<Engine> {
  const note = live.emit;
  const copyOptions: CopyOptions = {
    source: options.source,
    target: options.target,
    operation: "copy",
    metadataSync: false,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.range ? { range: options.range } : {}),
    ...(options.includeTrashed ? { includeTrashed: true } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    // Without metadata an asset's copy result is final: deliver it live. With metadata it is not final
    // until metadata sync has run, so only progress is reported during the upload phase.
    ...(options.dryRun || metadata ? {} : { onAsset: (asset: CopyAssetResult) => live.asset(mapCopy(asset, undefined, false, options.signal?.aborted === true)) }),
    ...(options.dryRun ? {} : { onProgress: (p: TransferProgress) => live.progress("copying", p.assetsDone, p.assetsTotal, p.bytesDone, p.bytesTotal) }),
  };
  const result = await copyAssets(copyOptions);
  if (result.kind === "transfer-preview") {
    const compared = metadata ? await compareAlreadyPresent(options, result) : { results: new Map<string, StepMetadata>(), warnings: [] };
    return {
      assets: mapPlan(result, "copy", compared.results, metadata),
      warnings: [...planNotes(result), ...compared.warnings],
      sourceVersion: result.sourceVersion,
      targetVersion: result.targetVersion,
      bytesCopied: 0,
      bytesToTransfer: result.summary.bytesToTransfer,
    };
  }

  const aborted = () => options.signal?.aborted === true;
  const metaById = new Map<string, StepMetadata>();
  const warnings = [...result.warnings];
  const finalOf = (asset: CopyAssetResult) => mapCopy(asset, metaById.get(asset.id), metadata, aborted());
  const push = metadata ? sequence(result.assets.map((asset) => asset.id), live) : undefined;
  if (push) for (const asset of result.assets) if (!isVerifiedCopy(asset)) push(asset.id, finalOf(asset));
  if (metadata && !aborted()) {
    const verified = result.assets.filter(isVerifiedCopy);
    const uploaded = verified.filter((asset) => asset.status === "copied").length;
    if (uploaded > 0) note({ type: "phase", phase: "metadata-wait", message: `Waiting for the target to read metadata of ${uploaded} uploaded asset(s).` });
    const notReady = await waitForTargetMetadata(options.target, verified, options.metadataWait, options.signal);
    for (const [id, reason] of notReady) {
      metaById.set(id, { status: aborted() ? "cancelled" : "failed", message: `target metadata not ready: ${reason}` });
    }
    const byId = new Map(result.assets.map((asset) => [asset.id, asset]));
    for (const id of notReady.keys()) push!(id, finalOf(byId.get(id)!));
    if (!aborted()) {
      const ready = verified.filter((asset) => !notReady.has(asset.id)).map((asset) => asset.id);
      let done = 0;
      const sync = await syncIds(options, ready, false, (id, value) => {
        metaById.set(id, value);
        push!(id, finalOf(byId.get(id)!));
        live.progress("metadata", ++done, ready.length);
      });
      for (const [id, value] of sync.results) metaById.set(id, value);
      warnings.push(...sync.warnings);
    }
  }
  return {
    assets: result.assets.map(finalOf),
    warnings: metadata ? warnings.filter((m) => !m.includes("not compared or synchronized")) : warnings,
    sourceVersion: result.sourceVersion,
    targetVersion: result.targetVersion,
    bytesCopied: result.summary.bytesCopied,
    bytesToTransfer: 0,
  };
}

async function runMove(options: StepOptions, metadata: boolean, live: Live): Promise<Engine> {
  const note = live.emit;
  const result = await moveAssets({
    source: options.source,
    target: options.target,
    operation: "move",
    metadataSync: metadata,
    ...metaFlags(options),
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.range ? { range: options.range } : {}),
    ...(options.includeTrashed ? { includeTrashed: true } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.dryRun
      ? {}
      : {
        onAsset: (asset: MoveAssetResult) => live.asset(mapMove(asset)),
        onProgress: (p: TransferProgress) =>
          live.progress(p.phase, p.assetsDone, p.assetsTotal, p.phase === "copying" ? p.bytesDone : undefined, p.phase === "copying" ? p.bytesTotal : undefined),
      }),
    ...(metadata
      ? {
        beforeMetadataSync: async (verified: CopyAssetResult[]) => {
          const uploaded = verified.filter((asset) => asset.status === "copied").length;
          if (uploaded > 0) note({ type: "phase", phase: "metadata-wait", message: `Waiting for the target to read metadata of ${uploaded} uploaded asset(s).` });
          return waitForTargetMetadata(options.target, verified, options.metadataWait, options.signal);
        },
      }
      : {}),
  });
  if (result.kind === "transfer-preview") {
    const compared = metadata ? await compareAlreadyPresent(options, result) : { results: new Map<string, StepMetadata>(), warnings: [] };
    return {
      assets: mapPlan(result, "move", compared.results, metadata),
      warnings: [...planNotes(result), ...compared.warnings],
      sourceVersion: result.sourceVersion,
      targetVersion: result.targetVersion,
      bytesCopied: 0,
      bytesToTransfer: result.summary.bytesToTransfer,
    };
  }
  return {
    assets: result.assets.map(mapMove),
    warnings: result.warnings,
    sourceVersion: result.sourceVersion,
    targetVersion: result.targetVersion,
    bytesCopied: result.summary.bytesCopied,
    bytesToTransfer: 0,
  };
}

/**
 * sync_metadata: the asset set is planTransfer's classification of the source (same range/kind and
 * eligibility rules as copy). Only assets whose every component is already on the target (active, matched
 * by checksum) are synchronized, and only the primary asset is touched. Assets not on the target are
 * reported as skipped, never uploaded; assets in the target trash are reported and skipped.
 */
async function runSyncMetadata(options: StepOptions, live: Live): Promise<Engine> {
  const plan = await planTransfer({
    source: options.source,
    target: options.target,
    operation: "copy",
    // sync_metadata never uploads or downloads: require only what metadata sync needs (not asset.upload).
    metadataSync: metaFlags(options),
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.range ? { range: options.range } : {}),
    ...(options.includeTrashed ? { includeTrashed: true } : {}),
  });
  const aborted = () => options.signal?.aborted === true;
  const ids = plan.assets.filter((asset) => asset.status === "already-present").map((asset) => asset.id);
  const results = new Map<string, StepMetadata>();
  const push = sequence(plan.assets.map((asset) => asset.id), live);
  const toResult = (asset: TransferPlan["assets"][number]): StepAssetResult => {
    const base = { id: asset.id, fileName: asset.fileName, trashed: false };
    if (asset.status === "would-transfer") {
      return { ...base, outcome: "skipped", transfer: "not-on-target", metadata: "not-attempted", message: "Not on the target; sync_metadata never uploads (use copy)." };
    }
    if (asset.status === "in-target-trash") {
      return { ...base, outcome: "in-target-trash", transfer: "in-target-trash", metadata: "not-attempted", message: "Found in target trash; skipped." };
    }
    if (asset.status === "failed") {
      return { ...base, outcome: "failed", transfer: "failed", metadata: "not-attempted", message: planFailure(asset) ?? "Planning failed." };
    }
    const m = results.get(asset.id);
    const extra = { ...(m?.changedFields ? { changedFields: m.changedFields } : {}), ...(m?.message ? { message: m.message } : {}) };
    const common = { ...base, transfer: "already-present" as const, metadata: m?.status ?? "cancelled" as StepMetadataStatus, ...extra };
    switch (m?.status) {
      case "synced": return { ...common, outcome: "synced" };
      case "would-update": return { ...common, outcome: "would-sync" };
      case "unchanged": return { ...common, outcome: "unchanged" };
      case "failed": return { ...common, outcome: "failed" };
      default: return { ...common, outcome: "cancelled", metadata: "cancelled" };
    }
  };
  // Assets that need no metadata work are final now; the rest follow as each sync finishes.
  for (const asset of plan.assets) if (asset.status !== "already-present") push(asset.id, toResult(asset));
  const byId = new Map(plan.assets.map((asset) => [asset.id, asset]));
  let done = 0;
  const sync = aborted()
    ? { results: new Map<string, StepMetadata>(), warnings: [] }
    : await syncIds(options, ids, options.dryRun === true, (id, value) => {
      results.set(id, value);
      push(id, toResult(byId.get(id)!));
      live.progress("metadata", ++done, ids.length);
    });
  for (const [id, value] of sync.results) results.set(id, value);
  const assets = plan.assets.map((asset) => {
    const final = toResult(asset);
    push(asset.id, final);
    return final;
  });
  return {
    assets,
    warnings: [...planNotes(plan), ...sync.warnings, LIVE_PHOTO_NOTE],
    sourceVersion: plan.sourceVersion,
    targetVersion: plan.targetVersion,
    bytesCopied: 0,
    bytesToTransfer: 0,
  };
}

function validate(options: StepOptions): void {
  if (options.operation !== "copy" && options.operation !== "move" && options.operation !== "sync_metadata") {
    throw new TransferPlanError("Operation must be copy, move or sync_metadata.");
  }
  for (const name of ["metadata", "dryRun", "includeAlbums", "createMissingAlbums", "includeTags", "includeTrashed"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "boolean") {
      throw new TransferPlanError(`${name} must be a boolean.`);
    }
  }
  if (options.operation === "move" && options.includeTrashed) {
    throw new TransferPlanError("Including source trash is not supported for a move: it would trash assets that are already trashed.");
  }
  if (options.operation === "sync_metadata" && options.metadata === false) {
    throw new TransferPlanError("sync_metadata always synchronizes metadata; metadata cannot be disabled.");
  }
  const usesMetadata = options.operation === "sync_metadata" || options.metadata === true;
  if (!usesMetadata && (options.includeAlbums || options.createMissingAlbums || options.includeTags)) {
    throw new TransferPlanError("Album and tag options require metadata sync to be enabled.");
  }
}

function summarize(assets: StepAssetResult[], engine?: Engine): StepSummary {
  const count = (outcome: StepAssetOutcome) => assets.filter((asset) => asset.outcome === outcome).length;
  return {
    assetsFound: assets.length,
    copied: count("copied"),
    moved: count("moved"),
    synced: count("synced"),
    unchanged: count("unchanged"),
    skipped: count("skipped"),
    inTargetTrash: count("in-target-trash"),
    failed: count("failed"),
    cancelled: count("cancelled"),
    wouldCopy: count("would-copy"),
    wouldMove: count("would-move"),
    wouldSync: count("would-sync"),
    bytesCopied: engine?.bytesCopied ?? 0,
    bytesToTransfer: engine?.bytesToTransfer ?? 0,
  };
}

export async function runStep(options: StepOptions): Promise<StepResult> {
  const events: StepEvent[] = [];
  const emit = (event: StepEvent) => {
    events.push(event);
    try {
      options.onEvent?.(event);
    } catch {
      // A failing listener must not affect the run.
    }
  };
  // Assets already delivered live (by ID); finish() reuses them so result.assets equals the asset events.
  const liveAssets = new Map<string, StepAssetResult>();
  const live: Live = {
    emit,
    asset: (asset) => {
      if (liveAssets.has(asset.id)) return;
      liveAssets.set(asset.id, asset);
      emit({ type: "asset", asset });
    },
    progress: (phase, done, total, bytesDone, bytesTotal) =>
      emit({
        type: "progress",
        phase,
        done,
        total,
        ...(bytesDone !== undefined ? { bytesDone } : {}),
        ...(bytesTotal !== undefined ? { bytesTotal } : {}),
      }),
  };
  const dryRun = options.dryRun === true;
  const aliases = { sourceAlias: String(options.source?.alias ?? ""), targetAlias: String(options.target?.alias ?? "") };
  const finish = (
    status: StepStatus,
    assets: StepAssetResult[],
    warnings: string[],
    engine?: Engine,
    error?: string,
  ): StepResult => {
    const unique = [...new Set(warnings)];
    for (const message of unique) emit({ type: "warning", message });
    if (error) emit({ type: "error", message: error });
    // Final list: what was already delivered live, plus anything not yet delivered, in engine order.
    // On cancel/error nothing is returned by an engine, so the live assets are the partial result.
    const final = (assets.length ? assets : [...liveAssets.values()]).map((asset) => liveAssets.get(asset.id) ?? asset);
    assets = final;
    for (const asset of assets) live.asset(asset);
    const summary = summarize(assets, engine);
    emit({ type: "summary", status, summary });
    return {
      kind: "step-run",
      operation: options.operation,
      dryRun,
      status,
      ...aliases,
      ...(engine ? { sourceVersion: engine.sourceVersion, targetVersion: engine.targetVersion } : {}),
      warnings: unique,
      assets,
      summary,
      events,
      ...(error ? { error } : {}),
    };
  };

  try {
    validate(options);
    if (options.signal?.aborted) return finish("cancelled", [], ["Step was cancelled before it started."]);
    const metadata = options.operation === "sync_metadata" || options.metadata === true;

    emit({ type: "phase", phase: "preflight", message: "Checking source and target instances." });
    // Refuse before any upload when the target cannot take metadata changes (copy/move with metadata).
    // The transfer functions and sync_metadata run the instance checks and version comparison themselves.
    if (metadata) await preflightMetadataFields({ source: options.source, target: options.target, ...metaFlags(options) });
    emit({ type: "phase", phase: "running", message: dryRun ? "Inspecting assets (dry run)." : "Running step." });

    const engine = options.operation === "copy"
      ? await runCopy(options, metadata, live)
      : options.operation === "move"
        ? await runMove(options, metadata, live)
        : await runSyncMetadata(options, live);

    const warnings = [...engine.warnings, ...(dryRun ? [DRY_RUN_WARNING] : [])];
    const delivered = engine.assets.map((asset) => liveAssets.get(asset.id) ?? asset);
    const summary = summarize(delivered);
    const status: StepStatus = summary.cancelled > 0 && options.signal?.aborted
      ? "cancelled"
      : summary.failed > 0 ? "completed_with_failures" : "completed";
    return finish(status, delivered, warnings, engine);
  } catch (error) {
    if (options.signal?.aborted) return finish("cancelled", [], ["Step was cancelled."]);
    return finish("error", [], [], undefined, safeMessage(error));
  }
}
