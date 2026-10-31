/** Pure validation and normalisation of job, step and schedule input. Throws HttpError(400, ..., { problems }). */

import { Cron } from "croner";
import { HttpError } from "../http.ts";
import { isUuid } from "../instances/store.ts";

export const OPERATIONS = ["copy", "move", "sync_metadata"] as const;
export type Operation = (typeof OPERATIONS)[number];
export type OnFailure = "continue" | "stop";
export type OnError = "stop" | "continue";
export type StepKind = "all" | "photos" | "videos";

export type StepRange = { from?: string; to: string } | { lastDays: number } | null;

/** Normalised per-step options; every key is always present. `range: null` means all assets. */
export type StepOptions = {
  range: StepRange;
  kind: StepKind;
  metadata: boolean;
  /** Metadata sync extras (additive). Require metadata; jobs saved before these existed lack the keys (treated as false). */
  includeAlbums?: boolean;
  createMissingAlbums?: boolean;
  includeTags?: boolean;
  dryRun: boolean;
};

export type StepInput = {
  operation: Operation;
  sourceId: string;
  targetId: string;
  options: StepOptions;
  onFailure: OnFailure;
  onError: OnError;
};

export type JobInput = { name: string; steps: StepInput[] };

export const MAX_STEPS = 50;
const OPTION_KEYS = new Set(["range", "kind", "metadata", "includeAlbums", "createMissingAlbums", "includeTags", "dryRun"]);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parseDate(value: unknown, label: string, problems: string[]): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}([T ].+)?$/.test(value.trim()) || Number.isNaN(Date.parse(value.trim()))) {
    problems.push(`${label} must be an ISO date such as 2024-01-31 or 2024-01-31T12:00:00Z.`);
    return undefined;
  }
  return value.trim();
}

export function normalizeOptions(raw: unknown, operation: Operation, label: string, problems: string[]): StepOptions {
  const out: StepOptions = { range: null, kind: "all", metadata: true, includeAlbums: false, createMissingAlbums: false, includeTags: false, dryRun: false };
  if (raw === undefined || raw === null) return out;
  if (!isObject(raw)) {
    problems.push(`${label}: options must be an object.`);
    return out;
  }
  for (const key of Object.keys(raw)) if (!OPTION_KEYS.has(key)) problems.push(`${label}: unknown option "${key}".`);

  const range = raw.range;
  if (range !== undefined && range !== null) {
    if (!isObject(range)) problems.push(`${label}: range must be an object or null.`);
    else if ("lastDays" in range) {
      const extra = Object.keys(range).filter((k) => k !== "lastDays");
      if (extra.length) problems.push(`${label}: range.lastDays cannot be combined with ${extra.join(", ")}.`);
      const n = range.lastDays;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 36500) problems.push(`${label}: range.lastDays must be an integer from 1 to 36500.`);
      else out.range = { lastDays: n };
    } else {
      for (const key of Object.keys(range)) if (key !== "from" && key !== "to") problems.push(`${label}: unknown range field "${key}".`);
      const hasFrom = range.from !== undefined && range.from !== null;
      if (range.to === undefined || range.to === null) problems.push(`${label}: range.to is required (from is optional, to is not).`);
      else {
        const to = parseDate(range.to, `${label}: range.to`, problems);
        const from = hasFrom ? parseDate(range.from, `${label}: range.from`, problems) : undefined;
        if (to && from && Date.parse(from) > Date.parse(to)) problems.push(`${label}: range.from must not be after range.to.`);
        if (to && (!hasFrom || from)) out.range = from ? { from, to } : { to };
      }
    }
  }

  if (raw.kind !== undefined) {
    if (raw.kind === "all" || raw.kind === "photos" || raw.kind === "videos") out.kind = raw.kind;
    else problems.push(`${label}: kind must be "all", "photos" or "videos".`);
  }
  if (raw.metadata !== undefined) {
    if (typeof raw.metadata !== "boolean") problems.push(`${label}: metadata must be a boolean.`);
    else if (operation === "sync_metadata" && !raw.metadata) problems.push(`${label}: metadata cannot be turned off for a sync_metadata step.`);
    else out.metadata = raw.metadata;
  }
  for (const key of ["includeAlbums", "createMissingAlbums", "includeTags"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "boolean") problems.push(`${label}: ${key} must be a boolean.`);
    else out[key] = raw[key];
  }
  if ((out.includeAlbums || out.createMissingAlbums || out.includeTags) && !out.metadata) {
    problems.push(`${label}: includeAlbums, createMissingAlbums and includeTags need metadata sync to be enabled.`);
  }
  if (out.createMissingAlbums && !out.includeAlbums) problems.push(`${label}: createMissingAlbums requires includeAlbums.`);
  if (raw.dryRun !== undefined) {
    if (typeof raw.dryRun !== "boolean") problems.push(`${label}: dryRun must be a boolean.`);
    else out.dryRun = raw.dryRun;
  }
  return out;
}

export function normalizeStep(raw: unknown, index: number, problems: string[]): StepInput | null {
  const label = `Step ${index + 1}`;
  if (!isObject(raw)) {
    problems.push(`${label} must be an object.`);
    return null;
  }
  const before = problems.length;
  const operation = raw.operation;
  if (!OPERATIONS.includes(operation as Operation)) problems.push(`${label}: operation must be one of ${OPERATIONS.join(", ")}.`);
  for (const f of ["sourceId", "targetId"] as const) {
    if (typeof raw[f] !== "string" || !isUuid(raw[f] as string)) problems.push(`${label}: ${f} must be an instance id.`);
  }
  if (raw.sourceId !== undefined && raw.sourceId === raw.targetId) problems.push(`${label}: source and target must be different instances.`);
  const onFailure = raw.onFailure ?? "continue";
  if (onFailure !== "continue" && onFailure !== "stop") problems.push(`${label}: onFailure must be "continue" or "stop".`);
  const onError = raw.onError ?? "stop";
  if (onError !== "stop" && onError !== "continue") problems.push(`${label}: onError must be "stop" or "continue".`);
  const options = normalizeOptions(raw.options, operation as Operation, label, problems);
  if (problems.length > before) return null;
  return {
    operation: operation as Operation,
    sourceId: raw.sourceId as string,
    targetId: raw.targetId as string,
    options,
    onFailure: onFailure as OnFailure,
    onError: onError as OnError,
  };
}

export function normalizeSteps(raw: unknown, problems: string[]): StepInput[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push("steps must be a non-empty array.");
    return null;
  }
  if (raw.length > MAX_STEPS) {
    problems.push(`A job can have at most ${MAX_STEPS} steps.`);
    return null;
  }
  const steps = raw.map((s, i) => normalizeStep(s, i, problems));
  return steps.every(Boolean) ? (steps as StepInput[]) : null;
}

export function normalizeName(raw: unknown, problems: string[]): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.trim().length > 100) {
    problems.push("name must be a string of 1 to 100 characters.");
    return null;
  }
  return raw.trim();
}

function fail(problems: string[]): never {
  throw new HttpError(400, "Invalid job.", { problems });
}

export function validateJobInput(body: Record<string, unknown>, opts: { partial: boolean } = { partial: false }): Partial<JobInput> {
  const problems: string[] = [];
  const out: Partial<JobInput> = {};
  if (!opts.partial || body.name !== undefined) out.name = normalizeName(body.name, problems) ?? undefined;
  if (!opts.partial || body.steps !== undefined) out.steps = normalizeSteps(body.steps, problems) ?? undefined;
  if (problems.length) fail(problems);
  return out;
}

/** Checks the steps against the registered instances; returns the problems found. */
export function checkStepInstances(steps: StepInput[], known: Set<string>): string[] {
  const problems: string[] = [];
  steps.forEach((s, i) => {
    if (!known.has(s.sourceId)) problems.push(`Step ${i + 1}: the source instance does not exist.`);
    if (!known.has(s.targetId)) problems.push(`Step ${i + 1}: the target instance does not exist.`);
  });
  return problems;
}

export const hasMoveStep = (steps: ReadonlyArray<{ operation: Operation }>) => steps.some((s) => s.operation === "move");

// ---- schedules ----

export type ScheduleInput = { cron: string; timezone: string; enabled: boolean; catchUp: boolean; confirmMove: boolean };

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
}

/** Five-field cron only (minute hour day month weekday); seconds are not supported. */
export function cronProblem(expr: string, timezone: string): string | null {
  if (expr.trim().split(/\s+/).length !== 5) return "cron must have five fields: minute hour day-of-month month day-of-week.";
  try {
    new Cron(expr, { timezone, paused: true });
    return null;
  } catch (err) {
    return `cron is not valid: ${(err as Error).message}`;
  }
}

export function nextRuns(cron: string, timezone: string, count = 3, from = new Date()): string[] {
  const c = new Cron(cron, { timezone, paused: true });
  return c.nextRuns(count, from).map((d) => d.toISOString());
}

export function validateScheduleInput(body: Record<string, unknown>, defaults: { timezone: string }): ScheduleInput {
  const problems: string[] = [];
  const known = new Set(["cron", "timezone", "enabled", "catchUp", "confirmMove"]);
  for (const k of Object.keys(body)) if (!known.has(k)) problems.push(`Unknown field "${k}".`);
  const bool = (k: string, d: boolean) => {
    if (body[k] === undefined) return d;
    if (typeof body[k] !== "boolean") problems.push(`${k} must be a boolean.`);
    return body[k] === true;
  };
  const timezone = body.timezone === undefined ? defaults.timezone : body.timezone;
  let tz = "UTC";
  if (typeof timezone !== "string" || !isValidTimezone(timezone)) problems.push("timezone must be an IANA time zone such as Europe/Lisbon.");
  else tz = timezone;
  const cron = body.cron;
  if (typeof cron !== "string") problems.push("cron must be a string.");
  else {
    const p = cronProblem(cron, tz);
    if (p) problems.push(p);
  }
  const out = { enabled: bool("enabled", true), catchUp: bool("catchUp", false), confirmMove: bool("confirmMove", false) };
  if (problems.length) throw new HttpError(400, "Invalid schedule.", { problems });
  return { cron: (cron as string).trim().replace(/\s+/g, " "), timezone: tz, ...out };
}
