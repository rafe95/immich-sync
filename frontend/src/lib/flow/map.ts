/** Pure graph model of the dashboard instance map: instances are nodes, job steps are edges. No Svelte. */
import type { Edge, Node } from "@xyflow/svelte";
import type { Instance } from "../api.ts";
import { instanceHealth, type Health } from "../dashboard.ts";
import type { JobRecord, StepRecord } from "../jobs.ts";
import { statusLabel, type Run, type RunStatus } from "../runs.ts";
import { opTone, type InstanceNodeData, type LabelEdgeData } from "./ops.ts";

export type MapInput = {
  instances: Instance[];
  jobs: JobRecord[];
  lastResults: Record<string, { status: RunStatus; finishedAt: string | null } | null>;
  active: Array<{ run: Run; percent: number | null; queued: boolean; /** The step that is live now when known from the event stream; the run record may be older. */ step?: number | null }>;
};
export type Position = { x: number; y: number };
export type Layout = Record<string, Position>;

export const COLUMN_GAP = 320;
export const ROW_GAP = 180;
const LAYOUT_KEY = "immich-sync.map-layout.v1";
const UNKNOWN_PREFIX = "unknown:";

const pad = (n: number) => String(n).padStart(2, "0");
/** Local date and time, e.g. "2026-11-01 03:00". */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const endpoint = (id: string, known: Set<string>) => (known.has(id) ? id : `${UNKNOWN_PREFIX}${id}`);

function instanceData(i: Instance): InstanceNodeData {
  const health: Health = instanceHealth(i);
  return { alias: i.alias, isDefault: i.isDefault, version: i.lastCheck?.version ?? null, checkedAt: i.lastCheckedAt, health, activity: null };
}

function edgeLabel(job: JobRecord, step: StepRecord, position: number, input: MapInput): Pick<LabelEdgeData, "label" | "style"> {
  const active = input.active.find((a) => a.run.settings.jobId === job.id);
  if (active && !active.queued) {
    const current = active.step ?? active.run.steps.find((s) => s.status === "running")?.position ?? active.run.steps[0]?.position ?? 1;
    if (current === position) return { label: `${job.name} · ${active.percent === null ? "running" : `${Math.round(active.percent)}%`}`, style: "running" };
  }
  if (active?.queued && position === 1) return { label: `${job.name} · waiting for lock`, style: "muted" };

  const s = job.schedule;
  let base: Pick<LabelEdgeData, "label" | "style">;
  if (!s) base = { label: `${job.name} · not scheduled`, style: "muted" };
  else if (!s.enabled) base = { label: `${job.name} · paused`, style: "muted" };
  else if (step.operation === "move" && s.moveConfirmedAt === null) base = { label: `${job.name} · move not confirmed`, style: "warning" };
  else base = { label: `${job.name} · ${s.nextRuns[0] ? formatWhen(s.nextRuns[0]) : "scheduled"}`, style: "solid" };

  const last = input.lastResults[job.id];
  return last ? { ...base, label: `${base.label} · last: ${statusLabel(last.status)}` } : base;
}

export function buildMap(input: MapInput): { nodes: Node<InstanceNodeData>[]; edges: Edge<LabelEdgeData>[] } {
  const known = new Set(input.instances.map((i) => i.id));
  const nodes = new Map<string, Node<InstanceNodeData>>();
  for (const i of input.instances) nodes.set(i.id, { id: i.id, type: "instance", position: { x: 0, y: 0 }, data: instanceData(i) });

  const edges: Edge<LabelEdgeData>[] = [];
  const lanes = new Map<string, number>();
  for (const job of input.jobs) {
    job.steps.forEach((step, idx) => {
      const position = idx + 1;
      const source = endpoint(step.sourceId, known);
      const target = endpoint(step.targetId, known);
      for (const [nodeId, rawId] of [[source, step.sourceId], [target, step.targetId]] as const) {
        if (!nodes.has(nodeId)) {
          const data: InstanceNodeData = {
            alias: "Unknown instance", isDefault: false, version: null, checkedAt: null,
            health: { tone: "error", label: `Instance ${rawId.slice(0, 8)} no longer exists` }, activity: null,
          };
          nodes.set(nodeId, { id: nodeId, type: "instance", position: { x: 0, y: 0 }, data });
        }
      }
      const { label, style } = edgeLabel(job, step, position, input);
      const pair = `${source}>${target}`;
      const lane = lanes.get(pair) ?? 0;
      lanes.set(pair, lane + 1);
      edges.push({ id: `${job.id}:${position}`, type: "label", source, target, data: { label, tone: opTone(step.operation), style, jobId: job.id, lane } as LabelEdgeData });
    });
  }

  // A running ad-hoc run (no saved job) draws a temporary line for its current step.
  for (const a of input.active) {
    if (a.queued || input.jobs.some((j) => j.id === a.run.settings.jobId)) continue;
    const current = a.step ?? a.run.steps.find((s) => s.status === "running")?.position ?? a.run.steps[0]?.position ?? 1;
    const step = a.run.settings.steps.find((s) => s.position === current);
    if (!step) continue;
    const source = endpoint(step.source.id, known);
    const target = endpoint(step.target.id, known);
    if (!nodes.has(source) || !nodes.has(target)) continue;
    const pair = `${source}>${target}`;
    const lane = lanes.get(pair) ?? 0;
    lanes.set(pair, lane + 1);
    const label = `${a.run.jobName} · ${a.percent === null ? "running" : `${Math.round(a.percent)}%`}`;
    edges.push({ id: `run:${a.run.id}:${current}`, type: "label", source, target, data: { label, tone: opTone(step.operation), style: "running", runId: a.run.id, lane } as LabelEdgeData });
    const src = nodes.get(source)!;
    const dst = nodes.get(target)!;
    dst.data.activity = { kind: "lock", job: a.run.jobName };
    if (!src.data.activity) src.data.activity = { kind: "reading", job: a.run.jobName };
  }

  for (const a of input.active) {
    const job = input.jobs.find((j) => j.id === a.run.settings.jobId);
    if (!job) continue;
    const name = job.name;
    if (a.queued) {
      const first = job.steps[0];
      if (!first) continue;
      for (const id of [endpoint(first.sourceId, known), endpoint(first.targetId, known)]) {
        const n = nodes.get(id);
        if (n && !n.data.activity) n.data.activity = { kind: "waiting", job: name };
      }
      continue;
    }
    const current = a.step ?? a.run.steps.find((s) => s.status === "running")?.position ?? a.run.steps[0]?.position ?? 1;
    const step = job.steps[current - 1];
    if (!step) continue;
    const src = nodes.get(endpoint(step.sourceId, known));
    const dst = nodes.get(endpoint(step.targetId, known));
    if (dst) dst.data.activity = { kind: "lock", job: name };
    if (src && !src.data.activity) src.data.activity = { kind: "reading", job: name };
  }

  return { nodes: [...nodes.values()], edges };
}

export const ADD_INSTANCE_NODE_ID = "add-instance";

/** The dashed "Add instance" box. It is never dragged or saved; see `placeholderPosition`. */
export const addInstanceNode = (): Node => ({ id: ADD_INSTANCE_NODE_ID, type: "add", position: { x: 0, y: 0 }, draggable: false, selectable: false, data: {} });

/** Below the lowest node and in line with the left-most one, wherever the user has moved the others. */
export const placeholderPosition = (positions: readonly Position[]): Position =>
  positions.length ? { x: Math.min(...positions.map((p) => p.x)), y: Math.max(...positions.map((p) => p.y)) + ROW_GAP } : { x: 0, y: 0 };

/** Columns: only-source 0, both 1, only-target 2, unconnected 0 below the rest. */
export function autoLayout(nodes: Node[], edges: Edge[]): Layout {
  const sources = new Set(edges.map((e) => e.source));
  const targets = new Set(edges.map((e) => e.target));
  const rows = [0, 0, 0];
  const out: Layout = {};
  const loners: Node[] = [];
  for (const n of nodes) {
    const s = sources.has(n.id);
    const t = targets.has(n.id);
    if (!s && !t) {
      loners.push(n);
      continue;
    }
    const col = s && t ? 1 : s ? 0 : 2;
    out[n.id] = { x: col * COLUMN_GAP, y: rows[col]++ * ROW_GAP };
  }
  let y = rows[0] * ROW_GAP;
  for (const n of loners) {
    out[n.id] = { x: 0, y };
    y += ROW_GAP;
  }
  return out;
}

/** Saved positions win for ids that still exist; stale ids are dropped; new ids keep their automatic position. */
export function mergeLayout(auto: Layout, saved: Layout | null): Layout {
  if (!saved) return { ...auto };
  const out: Layout = {};
  for (const id of Object.keys(auto)) out[id] = saved[id] ?? auto[id];
  return out;
}

const isPosition = (v: unknown): v is Position => !!v && typeof v === "object" && Number.isFinite((v as Position).x) && Number.isFinite((v as Position).y);

export function loadLayout(): Layout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const out: Layout = {};
    for (const [k, v] of Object.entries(parsed)) if (isPosition(v)) out[k] = { x: v.x, y: v.y };
    return out;
  } catch {
    return null;
  }
}

export function saveLayout(pos: Layout | null): void {
  try {
    if (pos === null) localStorage.removeItem(LAYOUT_KEY);
    else localStorage.setItem(LAYOUT_KEY, JSON.stringify(pos));
  } catch {
    /* storage unavailable: the map still works with automatic positions */
  }
}
