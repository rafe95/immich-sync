/** Pure helpers for the Jobs screen: step and schedule editing, client-side validation mirroring the backend, summaries. */

import type { Kind, Operation } from "./runs.ts";

export type OnFailure = "continue" | "stop";
export type OnError = "stop" | "continue";
export type RangeMode = "all" | "window" | "lastDays";

export type StepRange = { from?: string; to?: string } | { lastDays: number } | null;
export type StepOptionsRecord = {
  range?: StepRange;
  kind?: Kind;
  metadata?: boolean;
  includeAlbums?: boolean;
  createMissingAlbums?: boolean;
  includeTags?: boolean;
  includeEdits?: boolean;
  includeTrashed?: boolean;
  dryRun?: boolean;
};
export type StepRecord = {
  id?: string;
  operation: Operation;
  sourceId: string;
  targetId: string;
  sourceAlias?: string | null;
  targetAlias?: string | null;
  options: StepOptionsRecord;
  onFailure: OnFailure;
  onError: OnError;
};
export type ScheduleRecord = {
  id: string;
  jobId: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  catchUp: boolean;
  moveConfirmedAt: string | null;
  nextRuns: string[];
  jobName?: string | null;
};
export type JobRecord = { id: string; name: string; hasMove: boolean; steps: StepRecord[]; schedule: ScheduleRecord | null; createdAt: string; updatedAt: string };
export type ScheduleInput = { cron: string; timezone: string; enabled: boolean; catchUp: boolean; confirmMove: boolean };

export const MAX_STEPS = 50;
export const OP_LABEL: Record<Operation, string> = { copy: "Copy", move: "Move", sync_metadata: "Sync metadata" };

/** One step as edited in the form. `key` is a client-only identity for keyed lists. */
export type StepForm = {
  key: string;
  operation: Operation;
  sourceId: string;
  targetId: string;
  rangeMode: RangeMode;
  from: string;
  to: string;
  lastDays: string;
  kind: Kind;
  metadata: boolean;
  includeAlbums: boolean;
  createMissingAlbums: boolean;
  includeTags: boolean;
  includeEdits: boolean;
  includeTrashed: boolean;
  onFailure: OnFailure;
  onError: OnError;
};

let counter = 0;
const nextKey = () => `step-${++counter}`;

export const defaultStep = (over: Partial<StepForm> = {}): StepForm =>
  ({
    key: nextKey(), operation: "copy", sourceId: "", targetId: "", rangeMode: "all", from: "", to: "", lastDays: "30", kind: "all", metadata: true,
    includeAlbums: false, createMissingAlbums: false, includeTags: false, includeEdits: false, includeTrashed: false, onFailure: "continue", onError: "stop", ...over,
  }) satisfies StepForm;

/** Restores the rules the backend enforces after any edit (call after changing operation or the metadata options). */
export function normalizeStepForm(s: StepForm): StepForm {
  const out = { ...s };
  if (out.operation === "sync_metadata") out.metadata = true;
  if (!out.metadata) out.includeAlbums = out.createMissingAlbums = out.includeTags = out.includeEdits = false;
  if (!out.includeAlbums) out.createMissingAlbums = false;
  if (out.operation === "move") out.includeTrashed = false;
  return out;
}

export function stepFromRecord(r: StepRecord): StepForm {
  const o = r.options ?? {};
  const range = o.range ?? null;
  const base: Partial<StepForm> = { rangeMode: "all" };
  if (range && "lastDays" in range) Object.assign(base, { rangeMode: "lastDays", lastDays: String(range.lastDays) });
  else if (range) Object.assign(base, { rangeMode: "window", from: range.from ?? "", to: range.to ?? "" });
  return normalizeStepForm(
    defaultStep({
      ...base, operation: r.operation, sourceId: r.sourceId, targetId: r.targetId, kind: o.kind ?? "all", metadata: o.metadata ?? true,
      includeAlbums: o.includeAlbums === true, createMissingAlbums: o.createMissingAlbums === true, includeTags: o.includeTags === true, includeEdits: o.includeEdits === true,
      includeTrashed: o.includeTrashed === true, onFailure: r.onFailure ?? "continue", onError: r.onError ?? "stop",
    }),
  );
}

const dateOk = (v: string) => /^\d{4}-\d{2}-\d{2}([T ].+)?$/.test(v.trim()) && !Number.isNaN(Date.parse(v.trim()));
const lastDaysValue = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);

export function validateStep(s: StepForm, index: number): string[] {
  const l = `Step ${index + 1}`;
  const p: string[] = [];
  if (!s.sourceId) p.push(`${l}: choose a source.`);
  if (!s.targetId) p.push(`${l}: choose a target.`);
  if (s.sourceId && s.sourceId === s.targetId) p.push(`${l}: source and target must be different instances.`);
  if (s.rangeMode === "window") {
    if (!s.from && !s.to) p.push(`${l}: a date window needs a from date, a to date, or both.`);
    if (s.from && !dateOk(s.from)) p.push(`${l}: the from date is not valid.`);
    if (s.to && !dateOk(s.to)) p.push(`${l}: the to date is not valid.`);
    if (s.from && s.to && dateOk(s.from) && dateOk(s.to) && Date.parse(s.from) > Date.parse(s.to)) p.push(`${l}: the from date must not be after the to date.`);
  } else if (s.rangeMode === "lastDays") {
    const n = lastDaysValue(s.lastDays);
    if (!Number.isInteger(n) || n < 1 || n > 36500) p.push(`${l}: "last N days" must be a whole number from 1 to 36500.`);
  }
  if (s.operation === "move" && s.includeTrashed) p.push(`${l}: including the source's trash is not supported for a move.`);
  if ((s.includeAlbums || s.createMissingAlbums || s.includeTags || s.includeEdits) && !s.metadata) p.push(`${l}: albums, tags and edits need metadata sync.`);
  if (s.createMissingAlbums && !s.includeAlbums) p.push(`${l}: creating missing albums requires album sync.`);
  return p;
}

export function validateJob(name: string, steps: StepForm[]): string[] {
  const p: string[] = [];
  if (!name.trim() || name.trim().length > 100) p.push("The name must be 1 to 100 characters.");
  if (steps.length === 0) p.push("Add at least one step.");
  if (steps.length > MAX_STEPS) p.push(`A job can have at most ${MAX_STEPS} steps.`);
  steps.forEach((s, i) => p.push(...validateStep(s, i)));
  return p;
}

/** The request body for one step. Optional keys are sent only when set, mirroring the backend defaults. */
export function buildStepBody(f: StepForm): Record<string, unknown> {
  const s = normalizeStepForm(f);
  let range: StepRange = null;
  if (s.rangeMode === "lastDays") range = { lastDays: lastDaysValue(s.lastDays) };
  else if (s.rangeMode === "window") range = { ...(s.from ? { from: s.from } : {}), ...(s.to ? { to: s.to } : {}) };
  const options: Record<string, unknown> = { range, kind: s.kind, metadata: s.metadata };
  if (s.includeAlbums) options.includeAlbums = true;
  if (s.createMissingAlbums) options.createMissingAlbums = true;
  if (s.includeTags) options.includeTags = true;
  if (s.includeEdits) options.includeEdits = true;
  if (s.operation !== "move" && s.includeTrashed) options.includeTrashed = true;
  return { operation: s.operation, sourceId: s.sourceId, targetId: s.targetId, options, onFailure: s.onFailure, onError: s.onError };
}

export function buildJobBody(name: string, steps: StepForm[]): { ok: true; body: { name: string; steps: Record<string, unknown>[] } } | { ok: false; problems: string[] } {
  const problems = validateJob(name, steps);
  if (problems.length) return { ok: false, problems };
  return { ok: true, body: { name: name.trim(), steps: steps.map(buildStepBody) } };
}

/**
 * A stable string of what the form would save, for "has anything changed?". Client-only keys are left out. A form that
 * cannot be saved yet is compared by its raw fields, so editing it still counts as a change.
 */
export function jobSnapshot(name: string, steps: StepForm[]): string {
  const built = buildJobBody(name, steps);
  if (built.ok) return JSON.stringify(built.body);
  return JSON.stringify({ name, steps: steps.map(({ key: _key, ...rest }) => rest) });
}

/** Moves an item; returns a new array (the same one if the move is out of range). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

export const duplicateStep = (s: StepForm): StepForm => ({ ...s, key: nextKey() });
export const hasMove = (steps: ReadonlyArray<{ operation: Operation }>) => steps.some((s) => s.operation === "move");

export function stepSummary(s: StepForm | StepRecord, alias: (id: string) => string): string {
  const f = "key" in s ? s : stepFromRecord(s);
  const parts = [`${OP_LABEL[f.operation]} · ${alias(f.sourceId)} → ${alias(f.targetId)}`];
  parts.push(f.kind === "all" ? "photos and videos" : `${f.kind} only`);
  if (f.rangeMode === "lastDays") parts.push(`last ${f.lastDays} days`);
  else if (f.rangeMode === "window") parts.push(`${f.from || "…"} to ${f.to || "…"}`);
  if (f.operation !== "sync_metadata") parts.push(f.metadata ? "metadata on" : "metadata off");
  const extras = [f.includeAlbums && "albums", f.includeTags && "tags", f.includeEdits && "edits"].filter(Boolean);
  if (extras.length) parts.push(`with ${extras.join(" and ")}`);
  if (f.includeTrashed) parts.push("including source trash");
  return parts.join(" · ");
}

// ---- schedules ----

export type Preset = "hourly" | "daily" | "weekly" | "custom";
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export type ScheduleForm = {
  preset: Preset;
  minute: number;
  time: string; // HH:MM
  days: number[]; // 0 = Sunday
  custom: string;
  timezone: string;
  enabled: boolean;
  catchUp: boolean;
};

export const defaultScheduleForm = (timezone: string): ScheduleForm => ({ preset: "daily", minute: 0, time: "00:30", days: [1], custom: "", timezone, enabled: true, catchUp: false });

const parseTime = (t: string): [number, number] | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? [h, mi] : null;
};

/** The cron expression for a form, or null when a preset is incomplete. */
export function cronFromForm(f: ScheduleForm): string | null {
  if (f.preset === "custom") return f.custom.trim().replace(/\s+/g, " ") || null;
  if (f.preset === "hourly") return Number.isInteger(f.minute) && f.minute >= 0 && f.minute <= 59 ? `${f.minute} * * * *` : null;
  const t = parseTime(f.time);
  if (!t) return null;
  if (f.preset === "daily") return `${t[1]} ${t[0]} * * *`;
  const days = [...new Set(f.days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  return days.length ? `${t[1]} ${t[0]} * * ${days.join(",")}` : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Recognises the expressions the presets produce; anything else is custom. */
export function formFromSchedule(s: Pick<ScheduleRecord, "cron" | "timezone" | "enabled" | "catchUp">): ScheduleForm {
  const base = { ...defaultScheduleForm(s.timezone), enabled: s.enabled, catchUp: s.catchUp, custom: s.cron, preset: "custom" as Preset };
  const f = s.cron.trim().split(/\s+/);
  if (f.length === 5 && /^\d{1,2}$/.test(f[0]!)) {
    const minute = Number(f[0]);
    if (minute <= 59 && f[1] === "*" && f[2] === "*" && f[3] === "*" && f[4] === "*") return { ...base, preset: "hourly", minute };
    if (/^\d{1,2}$/.test(f[1]!) && Number(f[1]) <= 23 && f[2] === "*" && f[3] === "*" && minute <= 59) {
      const time = `${pad(Number(f[1]))}:${pad(minute)}`;
      if (f[4] === "*") return { ...base, preset: "daily", time };
      if (/^[0-6](,[0-6])*$/.test(f[4]!)) return { ...base, preset: "weekly", time, days: f[4]!.split(",").map(Number) };
    }
  }
  return base;
}

/** A plain-language reading for the preset shapes; null for custom expressions we do not describe. */
export function describeCron(cron: string): string | null {
  const f = formFromSchedule({ cron, timezone: "UTC", enabled: true, catchUp: false });
  const t = f.time;
  if (f.preset === "hourly") return `Every hour at minute ${pad(f.minute)}`;
  if (f.preset === "daily") return `Every day at ${t}`;
  if (f.preset === "weekly") return `Every ${f.days.map((d) => WEEKDAYS[d]).join(", ")} at ${t}`;
  return null;
}

/** Light client-side check; the backend (croner) has the final word and its message is shown on save. */
export function cronFormatProblem(cron: string): string | null {
  const fields = cron.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) return "A cron expression needs five fields: minute hour day-of-month month day-of-week.";
  if (!fields.every((f) => /^[0-9A-Za-z*/,\-?#LW]+$/.test(f))) return "A cron field contains characters that are not allowed.";
  return null;
}

export function validateScheduleForm(f: ScheduleForm, validTimezone: (tz: string) => boolean = isValidTimezone): string[] {
  const p: string[] = [];
  const cron = cronFromForm(f);
  if (!cron) p.push(f.preset === "custom" ? "Enter a cron expression." : f.preset === "weekly" && parseTime(f.time) ? "Choose at least one weekday." : "Enter a valid time.");
  else {
    const c = cronFormatProblem(cron);
    if (c) p.push(c);
  }
  if (!validTimezone(f.timezone)) p.push("Choose a valid IANA time zone such as Europe/Lisbon.");
  return p;
}

export function buildScheduleBody(f: ScheduleForm, confirmMove: boolean): { ok: true; body: ScheduleInput } | { ok: false; problems: string[] } {
  const problems = validateScheduleForm(f);
  if (problems.length) return { ok: false, problems };
  return { ok: true, body: { cron: cronFromForm(f)!, timezone: f.timezone, enabled: f.enabled, catchUp: f.catchUp, confirmMove } };
}

/** A move schedule that will be enabled must be confirmed explicitly (a prior confirmation on the job counts only while the job is unchanged, so ask again). */
export const needsMoveConfirmation = (steps: ReadonlyArray<{ operation: Operation }>, enabled: boolean) => enabled && hasMove(steps);

export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function browserTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimezone(tz) ? tz : "UTC";
  } catch {
    return "UTC";
  }
}

export function timezoneList(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list?.length) return list.includes("UTC") ? list : ["UTC", ...list];
  } catch {
    // fall through to the short fallback
  }
  return ["UTC", "Europe/Lisbon", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"];
}

export const filterTimezones = (all: readonly string[], q: string, limit = 50) => {
  const n = q.trim().toLowerCase().replaceAll(" ", "_");
  return (n ? all.filter((z) => z.toLowerCase().includes(n)) : [...all]).slice(0, limit);
};

export function formatWhen(iso: string, timezone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", ...(timezone && isValidTimezone(timezone) ? { timeZone: timezone } : {}) });
  } catch {
    return d.toLocaleString();
  }
}

export function scheduleSummary(s: ScheduleRecord | null): string {
  if (!s) return "No schedule";
  const what = describeCron(s.cron) ?? `Cron ${s.cron}`;
  return `${what} (${s.timezone})${s.enabled ? "" : " · paused"}`;
}
