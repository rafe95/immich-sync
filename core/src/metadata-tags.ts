import { bulkTagAssets, getAllTags, isHttpError, upsertTags, type TagResponseDto } from "@immich/sdk";
import { requestOpts, type Instance } from "./instance.ts";

export type TagAdditionPlan = {
  /** Tag values (full paths) missing on the target asset, in source order. */
  values: string[];
  /** Existing target tags (by exact value) that will be attached. */
  existing: TagResponseDto[];
  /** Values that do not exist on the target yet and must be created. */
  toCreate: string[];
};

export type TagApplyResult = {
  added: string[];
  errors: string[];
  cancelled: boolean;
};

function validateTag(value: unknown): asserts value is TagResponseDto {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as TagResponseDto).id !== "string" ||
    (value as TagResponseDto).id.length === 0 ||
    typeof (value as TagResponseDto).value !== "string" ||
    (value as TagResponseDto).value.length === 0
  ) {
    throw new Error("Immich returned an incomplete tag response.");
  }
}

/** Extracts tag values from an asset's `tags`, ignoring malformed entries. */
export function tagValues(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const values: string[] = [];
  for (const tag of tags) {
    const value = (tag as TagResponseDto | undefined)?.value;
    if (typeof value === "string" && value.length > 0 && !values.includes(value)) values.push(value);
  }
  return values;
}

async function listTargetTags(target: Instance, signal?: AbortSignal): Promise<TagResponseDto[]> {
  const response = await getAllTags({ ...requestOpts(target), signal });
  if (!Array.isArray(response)) throw new Error("Immich returned an incomplete tag listing response.");
  for (const tag of response) validateTag(tag);
  return response;
}

export async function planTagAdditions(
  target: Instance,
  sourceTags: unknown,
  targetAssetTags: unknown,
  signal?: AbortSignal,
): Promise<TagAdditionPlan> {
  const have = new Set(tagValues(targetAssetTags));
  const values = tagValues(sourceTags).filter((value) => !have.has(value));
  if (values.length === 0) return { values, existing: [], toCreate: [] };
  const targetTags = await listTargetTags(target, signal);
  const existing: TagResponseDto[] = [];
  const toCreate: string[] = [];
  for (const value of values) {
    const matches = targetTags.filter((tag) => tag.value === value);
    if (matches.length > 1) {
      throw new Error(`Multiple target tags match the exact value ${JSON.stringify(value)}; refusing an ambiguous update.`);
    }
    if (matches[0]) existing.push(matches[0]);
    else toCreate.push(value);
  }
  return { values, existing, toCreate };
}

function safeTagError(error: unknown): string {
  if (isHttpError(error)) return `HTTP ${error.status}`;
  return error instanceof Error ? error.message : "Tag request failed.";
}

/** Creates missing tags and attaches all planned tags additively; the caller re-reads the asset to verify. */
export async function applyTagAdditions(
  target: Instance,
  targetAssetId: string,
  plan: TagAdditionPlan,
  signal?: AbortSignal,
): Promise<TagApplyResult> {
  try {
    signal?.throwIfAborted();
    const tagIds = plan.existing.map((tag) => tag.id);
    if (plan.toCreate.length > 0) {
      const created = await upsertTags({ tagUpsertDto: { tags: plan.toCreate } }, { ...requestOpts(target), signal });
      if (!Array.isArray(created)) throw new Error("Immich returned an incomplete tag upsert response.");
      for (const tag of created) validateTag(tag);
      for (const value of plan.toCreate) {
        const match = created.find((tag) => tag.value === value);
        if (!match) throw new Error(`Target tag ${JSON.stringify(value)} could not be created.`);
        tagIds.push(match.id);
      }
    }
    signal?.throwIfAborted();
    const result = await bulkTagAssets(
      { tagBulkAssetsDto: { assetIds: [targetAssetId], tagIds } },
      { ...requestOpts(target), signal },
    );
    if (!result || typeof result.count !== "number") throw new Error("Immich returned an incomplete tag assignment response.");
    return { added: plan.values, errors: [], cancelled: false };
  } catch (error) {
    if (signal?.aborted) return { added: [], errors: [], cancelled: true };
    return { added: [], errors: [safeTagError(error)], cancelled: false };
  }
}
