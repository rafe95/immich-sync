import { isHttpError } from "@immich/sdk";

const MAX_DETAIL = 500;

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) || (value && typeof value === "object")) {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * "HTTP 400: <Immich's message>" for SDK HTTP errors, or null for anything else.
 * Immich's schema validation answers with a generic message plus an `errors` list naming the rejected fields,
 * so both are included.
 */
export function describeHttpError(error: unknown): string | null {
  if (!isHttpError(error)) return null;
  const data = error.data as { message?: unknown; errors?: unknown } | undefined;
  const message = Array.isArray(data?.message) ? data.message.map(String).join("; ") : text(data?.message);
  const errors = data?.errors === undefined ? "" : text(data.errors);
  const detail = [message, errors].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
  return `HTTP ${error.status}${detail ? `: ${detail}` : ""}`;
}
