/** Typed calls to the backend API. */

export type Health = { status: "ok" | "degraded"; database: boolean; version: string };

export async function getHealth(): Promise<Health> {
  const res = await fetch("/api/health");
  if (!res.ok && res.status !== 503) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Health;
}
