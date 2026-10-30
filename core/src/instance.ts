/** A registered Immich server: one URL plus one user's API key. */

export type Instance = {
  alias: string;
  /** Base API URL, ending in /api (e.g. https://photos.example.com/api). */
  apiUrl: string;
  apiKey: string;
};

export const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Per-call request options for @immich/sdk.
 *
 * The SDK's init() sets ONE global server; this tool always talks to a source AND a target,
 * so every SDK call gets its own base URL and key instead.
 */
export function requestOpts(instance: Instance): { baseUrl: string; headers: Record<string, string> } {
  return {
    baseUrl: instance.apiUrl.replace(/\/+$/, ""),
    headers: { "x-api-key": instance.apiKey },
  };
}

/** Validates the fields a user types when registering an instance. Returns a list of problems. */
export function validateInstanceInput(input: { alias: string; apiUrl: string; apiKey: string }): string[] {
  const problems: string[] = [];
  if (!ALIAS_PATTERN.test(input.alias)) {
    problems.push("Alias may only use letters, digits, '.', '_' and '-', and must start with a letter or digit.");
  }
  let url: URL | null = null;
  try {
    url = new URL(input.apiUrl);
  } catch {
    problems.push("API URL is not a valid URL.");
  }
  if (url && !["http:", "https:"].includes(url.protocol)) problems.push("API URL must start with http:// or https://.");
  if (url && (url.username || url.password)) problems.push("API URL must not contain credentials.");
  if (url && (url.search || url.hash)) problems.push("API URL must not contain query parameters or a fragment.");
  if (url && !url.pathname.replace(/\/+$/, "").endsWith("/api")) problems.push("API URL must end in /api.");
  if (!input.apiKey.trim()) problems.push("API key is required.");
  return problems;
}
