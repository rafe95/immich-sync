import {
  downloadAsset,
  uploadAsset,
  type AssetMediaCreateDto,
  type AssetResponseDto,
} from "@immich/sdk";
import { requestOpts, type Instance } from "./instance.ts";

export type StreamUploadOptions = {
  asset: AssetResponseDto;
  checksum: string;
  stream: ReadableStream<Uint8Array>;
  livePhotoVideoId?: string;
  signal?: AbortSignal;
};

type FetchInput = string | URL | Request;

function urlOf(input: FetchInput): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

function methodOf(input: FetchInput, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
}

export async function downloadOriginal(
  instance: Instance,
  assetId: string,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const mediaFetch = Object.assign(async (input: FetchInput, init?: RequestInit) => {
    const response = await fetch(input, init);
    const url = urlOf(input);
    if (
      methodOf(input, init) !== "GET" ||
      !url.pathname.endsWith(`/assets/${encodeURIComponent(assetId)}/original`) ||
      !response.ok
    ) {
      return response;
    }
    const streamBlob = {
      size: Number(response.headers.get("content-length") ?? 0),
      type: response.headers.get("content-type") ?? "",
      stream: () => response.body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    } as Blob;
    return new Proxy(response, {
      get(target, property) {
        if (property === "blob") return async () => streamBlob;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }, { preconnect: fetch.preconnect.bind(fetch) }) as typeof fetch;

  const blob = await downloadAsset(
    { id: assetId },
    { ...requestOpts(instance), signal, fetch: mediaFetch },
  );
  const stream = blob.stream();
  if (!stream) throw new Error("Immich returned no original media stream.");
  return stream as ReadableStream<Uint8Array>;
}

function quoted(value: string): string {
  return value.replace(/["\\\r\n]/g, "_");
}

function multipartStream(
  boundary: string,
  options: StreamUploadOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const asset = options.asset;
  const fields: Array<[string, string]> = [
    ["fileCreatedAt", asset.fileCreatedAt],
    ["fileModifiedAt", asset.fileModifiedAt],
    ["filename", asset.originalFileName],
  ];
  if (options.livePhotoVideoId) fields.push(["livePhotoVideoId", options.livePhotoVideoId]);

  const chunks = (async function* (): AsyncGenerator<Uint8Array> {
    for (const [name, value] of fields) {
      if (options.signal?.aborted) throw abortError(options.signal);
      yield encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"\r\n\r\n${value}\r\n`);
    }
    const mimeType = (asset.originalMimeType ?? "application/octet-stream").replace(/[\r\n]/g, "");
    yield encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="assetData"; filename="${quoted(asset.originalFileName)}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    );
    const reader = options.stream.getReader();
    const cancelReader = () => void reader.cancel(options.signal?.reason).catch(() => {});
    options.signal?.addEventListener("abort", cancelReader, { once: true });
    try {
      while (true) {
        if (options.signal?.aborted) throw abortError(options.signal);
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      options.signal?.removeEventListener("abort", cancelReader);
      reader.releaseLock();
    }
    yield encoder.encode(`\r\n--${boundary}--\r\n`);
  })();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await chunks.return?.(reason);
      await options.stream.cancel(reason).catch(() => {});
    },
  });
}

export async function uploadOriginal(
  instance: Instance,
  options: StreamUploadOptions,
): Promise<{ id: string; status: string }> {
  const boundary = `immich-sync-${crypto.randomUUID()}`;
  const mediaFetch = Object.assign(async (input: FetchInput, init?: RequestInit) => {
    const url = urlOf(input);
    if (methodOf(input, init) !== "POST" || !url.pathname.endsWith("/assets")) {
      return fetch(input, init);
    }

    const headers = new Headers(init?.headers);
    headers.set("content-type", `multipart/form-data; boundary=${boundary}`);
    const requestInit = {
      ...init,
      headers,
      body: multipartStream(boundary, options),
      duplex: "half",
    } as RequestInit;
    return fetch(input, requestInit);
  }, { preconnect: fetch.preconnect.bind(fetch) }) as typeof fetch;

  const dto: AssetMediaCreateDto = {
    assetData: new Blob([]),
    fileCreatedAt: options.asset.fileCreatedAt,
    fileModifiedAt: options.asset.fileModifiedAt,
    filename: options.asset.originalFileName,
    ...(options.livePhotoVideoId ? { livePhotoVideoId: options.livePhotoVideoId } : {}),
  };
  const response = await uploadAsset(
    { assetMediaCreateDto: dto, xImmichChecksum: options.checksum },
    { ...requestOpts(instance), signal: options.signal, fetch: mediaFetch },
  );
  if (!response || typeof response.id !== "string" || typeof response.status !== "string") {
    throw new Error("Immich returned an incomplete upload response.");
  }
  return response;
}