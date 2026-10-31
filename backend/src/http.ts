/** Small HTTP helpers shared by the route modules. */

export const json = (data: unknown, status = 200, headers?: Record<string, string>) =>
  Response.json(data, { status, headers });

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const errorResponse = (err: HttpError) => json({ message: err.message, ...err.extra }, err.status);

const MAX_BODY_BYTES = 64 * 1024;

/** Reads a JSON object body (size-limited); throws HttpError 400/413 otherwise. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large.");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}
