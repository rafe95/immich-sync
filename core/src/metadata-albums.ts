import { describeHttpError } from "./http-error.ts";
import {
  addAssetsToAlbums,
  createAlbum,
  getAllAlbums,
  type AlbumResponseDto,
} from "@immich/sdk";
import { requestOpts, type Instance } from "./instance.ts";

export type AlbumMembershipAddition = {
  albumName: string;
  albumId?: string;
};

export type AlbumMembershipPlan = AlbumMembershipAddition[] & {
  /** Source album names with no exact-name owned target album while creation is disabled. */
  skippedMissing?: string[];
};

export type AlbumMembershipApplyResult = {
  added: string[];
  errors: string[];
  cancelled: boolean;
};

function ownerId(album: AlbumResponseDto): string {
  return album.albumUsers[0]?.user?.id ?? "";
}

function validateAlbum(value: unknown): asserts value is AlbumResponseDto {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as AlbumResponseDto).id !== "string" ||
    (value as AlbumResponseDto).id.length === 0 ||
    typeof (value as AlbumResponseDto).albumName !== "string" ||
    (value as AlbumResponseDto).albumName.length === 0 ||
    !Array.isArray((value as AlbumResponseDto).albumUsers) ||
    (value as AlbumResponseDto).albumUsers.length === 0
  ) {
    throw new Error("Immich returned an incomplete album response.");
  }
  const first = (value as AlbumResponseDto).albumUsers[0];
  if (
    !first ||
    first.role !== "owner" ||
    !first.user ||
    typeof first.user.id !== "string" ||
    first.user.id.length === 0
  ) {
    throw new Error("Immich returned an album without a verifiable owner.");
  }
}

function validateAlbumList(value: unknown): AlbumResponseDto[] {
  if (!Array.isArray(value)) throw new Error("Immich returned an incomplete album listing response.");
  for (const album of value) validateAlbum(album);
  return value;
}

async function listAlbums(
  instance: Instance,
  query: { assetId?: string; isOwned?: boolean },
  signal?: AbortSignal,
): Promise<AlbumResponseDto[]> {
  const response = await getAllAlbums(query, { ...requestOpts(instance), signal });
  return validateAlbumList(response);
}

function ownedBy(albums: AlbumResponseDto[], userId: string): AlbumResponseDto[] {
  return albums.filter((album) => ownerId(album) === userId);
}

export async function planAlbumMembershipAdditions(
  source: Instance,
  target: Instance,
  sourceAssetId: string,
  targetAssetId: string,
  sourceOwnerId: string,
  targetOwnerId: string,
  createMissing: boolean,
  signal?: AbortSignal,
): Promise<AlbumMembershipPlan> {
  const sourceMemberships = ownedBy(
    await listAlbums(source, { assetId: sourceAssetId, isOwned: true }, signal),
    sourceOwnerId,
  );
  const albumNames = [...new Set(sourceMemberships.map((album) => album.albumName))];
  if (albumNames.length === 0) return [];

  const targetAlbums = ownedBy(await listAlbums(target, { isOwned: true }, signal), targetOwnerId);
  const targetMemberships = ownedBy(
    await listAlbums(target, { assetId: targetAssetId, isOwned: true }, signal),
    targetOwnerId,
  );
  const memberships = new Set(targetMemberships.map((album) => album.id));

  const additions: AlbumMembershipPlan = [];
  const skippedMissing: string[] = [];
  for (const albumName of albumNames) {
    const matches = targetAlbums.filter((album) => album.albumName === albumName);
    if (matches.length > 1) {
      throw new Error(`Multiple owned target albums match the exact name ${JSON.stringify(albumName)}; refusing an ambiguous update.`);
    }
    const match = matches[0];
    if (match && memberships.has(match.id)) continue;
    if (!match && !createMissing) {
      skippedMissing.push(albumName);
      continue;
    }
    additions.push({ albumName, ...(match ? { albumId: match.id } : {}) });
  }
  if (skippedMissing.length > 0) additions.skippedMissing = skippedMissing;
  return additions;
}

function safeAlbumError(error: unknown): string {
  const http = describeHttpError(error);
  if (http) return http;
  return error instanceof Error ? error.message : "Album request failed.";
}

export async function applyAlbumMembershipAdditions(
  target: Instance,
  targetAssetId: string,
  targetOwnerId: string,
  additions: AlbumMembershipPlan,
  signal?: AbortSignal,
): Promise<AlbumMembershipApplyResult> {
  const added: string[] = [];
  const errors: string[] = [];

  for (const addition of additions) {
    let albumId = addition.albumId;
    try {
      signal?.throwIfAborted();
      if (!albumId) {
        const created = await createAlbum(
          { createAlbumDto: { albumName: addition.albumName } },
          { ...requestOpts(target), signal },
        );
        validateAlbum(created);
        if (created.albumName !== addition.albumName || ownerId(created) !== targetOwnerId || created.shared !== false) {
          throw new Error("Created target album did not match the requested name and owner.");
        }
        albumId = created.id;
      }

      signal?.throwIfAborted();
      const result = await addAssetsToAlbums(
        { albumsAddAssetsDto: { albumIds: [albumId], assetIds: [targetAssetId] } },
        { ...requestOpts(target), signal },
      );
      if (!result || result.success !== true) {
        throw new Error("Immich reported album membership addition success=false.");
      }

      signal?.throwIfAborted();
      const memberships = ownedBy(
        await listAlbums(target, { assetId: targetAssetId, isOwned: true }, signal),
        targetOwnerId,
      );
      if (!memberships.some((album) => album.id === albumId)) {
        throw new Error("Target album membership could not be verified.");
      }
      added.push(addition.albumName);
    } catch (error) {
      if (signal?.aborted) return { added, errors, cancelled: true };
      errors.push(`${JSON.stringify(addition.albumName)}: ${safeAlbumError(error)}`);
    }
  }

  return { added, errors, cancelled: false };
}