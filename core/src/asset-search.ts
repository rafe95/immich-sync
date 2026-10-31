import { searchAssets, type AssetResponseDto, type MetadataSearchDto, type SearchFilter } from "@immich/sdk";
import { requestOpts, type Instance } from "./instance.ts";

const PAGE_SIZE = 250;

export class AssetSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetSearchError";
  }
}

/**
 * Searches with a `filter`. Trash state is always stated in the filter (`trashedAt`) because Immich (v3.3.5)
 * rejects the deprecated `withDeleted` flag when it is combined with `filter`, and does not document a default.
 * With `withDeleted`, active and trashed assets are searched separately, so trashed matches never depend on a default.
 */
export async function collectAssets(
  instance: Instance,
  filter: SearchFilter,
  withDeleted: boolean,
  signal?: AbortSignal,
): Promise<AssetResponseDto[]> {
  const active = await collectPages(instance, { ...filter, trashedAt: { eq: null } }, signal);
  if (!withDeleted) return active;
  const trashed = await collectPages(instance, { ...filter, trashedAt: { ne: null } }, signal);
  const byId = new Map<string, AssetResponseDto>();
  for (const asset of [...active, ...trashed]) byId.set(asset.id, asset);
  return [...byId.values()];
}

async function collectPages(instance: Instance, filter: SearchFilter, signal?: AbortSignal): Promise<AssetResponseDto[]> {
  const assets: AssetResponseDto[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let reportedTotal: number | null = null;
  let itemsRead = 0;

  while (true) {
    const metadataSearchDto: MetadataSearchDto = {
      filter,
      size: PAGE_SIZE,
      withExif: true,
      withStacked: true,
      ...(cursor ? { cursor } : {}),
    };
    const response = await searchAssets(
      { metadataSearchDto },
      { ...requestOpts(instance), signal },
    );
    const page = response.assets;
    // Numbers only (never cursor values or asset data), so a mismatch with a real server can be diagnosed from the log.
    const stats = () => `count=${page?.count}, items=${page?.items?.length}, total=${page?.total}, read so far=${itemsRead}, more pages=${page?.nextCursor ? "yes" : "no"}, size=${PAGE_SIZE}`;
    if (
      !Array.isArray(page?.items) ||
      !Number.isInteger(page.count) ||
      page.count !== page.items.length ||
      !Number.isInteger(page.total) ||
      page.total < 0 ||
      (page.nextCursor !== null && typeof page.nextCursor !== "string")
    ) {
      throw new AssetSearchError(`Immich returned an incomplete asset search response (${stats()}).`);
    }
    if (reportedTotal !== null && page.total !== reportedTotal) {
      throw new AssetSearchError(`Immich asset search total changed during pagination (${stats()}, first total=${reportedTotal}).`);
    }
    reportedTotal = page.total;
    itemsRead += page.count;
    if (itemsRead > page.total) throw new AssetSearchError(`Immich returned inconsistent asset search counts (${stats()}).`);
    assets.push(...page.items);
    const nextCursor = page.nextCursor;
    if (nextCursor === null) {
      if (itemsRead !== page.total) {
        throw new AssetSearchError(`Immich asset search ended before returning all matching assets (${stats()}).`);
      }
      break;
    }
    if (page.count === 0 || itemsRead >= page.total) {
      throw new AssetSearchError(`Immich returned an inconsistent asset search cursor (${stats()}).`);
    }
    if (cursors.has(nextCursor) || nextCursor === cursor) {
      throw new AssetSearchError(`Immich returned a repeated asset search cursor (${stats()}).`);
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }

  return assets;
}

export async function findAssetsByChecksum(
  instance: Instance,
  checksum: string,
  signal?: AbortSignal,
): Promise<AssetResponseDto[]> {
  const assets = await collectAssets(instance, { checksum: { eq: checksum } }, true, signal);
  if (assets.some((asset) => asset.checksum !== checksum)) {
    throw new AssetSearchError("Immich returned an asset that does not match the requested checksum.");
  }
  return assets;
}