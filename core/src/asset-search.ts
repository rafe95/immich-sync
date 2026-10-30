import { searchAssets, type AssetResponseDto, type MetadataSearchDto, type SearchFilter } from "@immich/sdk";
import { requestOpts, type Instance } from "./instance.ts";

const PAGE_SIZE = 250;

export class AssetSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetSearchError";
  }
}

export async function collectAssets(
  instance: Instance,
  filter: SearchFilter,
  withDeleted: boolean,
  signal?: AbortSignal,
): Promise<AssetResponseDto[]> {
  const assets: AssetResponseDto[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let reportedTotal: number | null = null;
  let itemsRead = 0;

  while (true) {
    const metadataSearchDto: MetadataSearchDto = {
      filter,
      size: PAGE_SIZE,
      withDeleted,
      withExif: true,
      withStacked: true,
      ...(cursor ? { cursor } : {}),
    };
    const response = await searchAssets(
      { metadataSearchDto },
      { ...requestOpts(instance), signal },
    );
    const page = response.assets;
    if (
      !Array.isArray(page?.items) ||
      !Number.isInteger(page.count) ||
      page.count !== page.items.length ||
      !Number.isInteger(page.total) ||
      page.total < 0 ||
      (page.nextCursor !== null && typeof page.nextCursor !== "string")
    ) {
      throw new AssetSearchError("Immich returned an incomplete asset search response.");
    }
    if (reportedTotal !== null && page.total !== reportedTotal) {
      throw new AssetSearchError("Immich asset search total changed during pagination.");
    }
    reportedTotal = page.total;
    itemsRead += page.count;
    if (itemsRead > page.total) throw new AssetSearchError("Immich returned inconsistent asset search counts.");
    assets.push(...page.items);
    const nextCursor = page.nextCursor;
    if (nextCursor === null) {
      if (itemsRead !== page.total) {
        throw new AssetSearchError("Immich asset search ended before returning all matching assets.");
      }
      break;
    }
    if (page.count === 0 || itemsRead >= page.total) {
      throw new AssetSearchError("Immich returned an inconsistent asset search cursor.");
    }
    if (cursors.has(nextCursor) || nextCursor === cursor) {
      throw new AssetSearchError("Immich returned a repeated asset search cursor.");
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