import { isHttpError } from "@immich/sdk";

const MAX_DETAIL = 300;

/** "HTTP 400: <Immich's validation message>" for SDK HTTP errors, or null for anything else. */
export function describeHttpError(error: unknown): string | null {
  if (!isHttpError(error)) return null;
  const message = (error.data as { message?: unknown } | undefined)?.message;
  const text = Array.isArray(message) ? message.map(String).join("; ") : typeof message === "string" ? message : "";
  const detail = text.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
  return `HTTP ${error.status}${detail ? `: ${detail}` : ""}`;
}
