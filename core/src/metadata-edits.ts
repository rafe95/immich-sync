import {
  editAsset,
  getAssetEdits,
  type AssetEditActionItemDto,
  type AssetEditActionItemResponseDto,
} from "@immich/sdk";
import { requestOpts, type Instance } from "./instance.ts";

export type EditPlan =
  /** Nothing to do: the source has no edits, or the target already has the same ones. */
  | { kind: "none" }
  /** The target already has different edits. They are never replaced or removed. */
  | { kind: "conflict"; message: string }
  | { kind: "apply"; edits: AssetEditActionItemDto[] };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toDtos(edits: AssetEditActionItemResponseDto[]): AssetEditActionItemDto[] {
  if (!Array.isArray(edits)) throw new Error("Immich returned an invalid edit list.");
  return edits.map((edit) => {
    if (!edit || typeof edit.action !== "string" || !edit.parameters || typeof edit.parameters !== "object") {
      throw new Error("Immich returned an invalid edit entry.");
    }
    return { action: edit.action, parameters: edit.parameters };
  });
}

function sameEdits(a: AssetEditActionItemDto[], b: AssetEditActionItemDto[]): boolean {
  return canonical(a) === canonical(b);
}

/**
 * Compares crop/rotate/mirror edits (read only). Edits are only copied onto a target that has none:
 * Immich replaces the whole edit list on write, so merging into existing target edits is not possible
 * without removing target data, which a sync never does.
 */
export async function planEditCopy(
  source: Instance,
  target: Instance,
  sourceAssetId: string,
  targetAssetId: string,
  signal?: AbortSignal,
): Promise<EditPlan> {
  const sourceEdits = toDtos((await getAssetEdits({ id: sourceAssetId }, { ...requestOpts(source), signal })).edits);
  if (sourceEdits.length === 0) return { kind: "none" };
  signal?.throwIfAborted();
  const targetEdits = toDtos((await getAssetEdits({ id: targetAssetId }, { ...requestOpts(target), signal })).edits);
  if (sameEdits(sourceEdits, targetEdits)) return { kind: "none" };
  if (targetEdits.length > 0) {
    return { kind: "conflict", message: "Target asset already has different edits; they were left unchanged." };
  }
  return { kind: "apply", edits: sourceEdits };
}

/** Applies a planned edit list to a target that had none and verifies the result by reading it back. */
export async function applyEditCopy(
  target: Instance,
  targetAssetId: string,
  edits: AssetEditActionItemDto[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await editAsset({ id: targetAssetId, assetEditsCreateDto: { edits } }, { ...requestOpts(target), signal });
  signal?.throwIfAborted();
  const verified = toDtos((await getAssetEdits({ id: targetAssetId }, { ...requestOpts(target), signal })).edits);
  if (!sameEdits(verified, edits)) throw new Error("Target edits could not be verified after applying them.");
}
