/**
 * The seam between run orchestration and the engine. The orchestration (runner.ts) is written against
 * this interface only; the real implementation, built on core's step runner, is injected later.
 */

import {
  checkInstance,
  runStep as coreRunStep,
  ROLE_LABELS,
  type Instance,
  type InstanceCheck,
  type Role,
  type StepEvent,
  type StepOptions as CoreStepOptions,
  type StepResult,
} from "@immich-sync/core";
import { DecryptError, decryptSecret } from "../crypto.ts";
import type { InstanceStore } from "../instances/store.ts";
import type { NewEvent, RunSettingsStep } from "./store.ts";

export type InstanceProblem = { instanceId: string; alias: string; message: string };

export type StepOutcome = {
  /** "error" means the step could not run at all (server down, key rejected); "completed_with_failures" means some assets failed. */
  status: "completed" | "completed_with_failures" | "error" | "cancelled";
  /** Per-step counts (found, transferred, already present, failed, trashed, metadata changes ...), stored as-is. */
  summary?: unknown;
  message?: string;
};

export type ExecutionContext = {
  runId: string;
  /** Aborted when the run is cancelled; stop after the current batch of assets. */
  signal: AbortSignal;
  /** Appends a structured log event to the run (info/warning/error lines, progress, asset, summary). */
  log(event: NewEvent): Promise<void>;
};

export type StepContext = ExecutionContext & {
  position: number;
  step: RunSettingsStep;
  /** Effective dry run for this step. */
  dryRun: boolean;
};

export interface StepExecutor {
  /**
   * Checks every instance the steps use (reachable, key accepted, required permissions for each role).
   * Called once before step 1; any problem stops the run before anything changes. Must not mutate anything.
   */
  validateInstances(steps: readonly RunSettingsStep[], ctx: ExecutionContext): Promise<InstanceProblem[]>;
  /** Runs one step. Should resolve (not throw) with an outcome; a throw is recorded as an "error" outcome. */
  runStep(ctx: StepContext): Promise<StepOutcome>;
}

/** Used until the engine is wired in: every run fails cleanly at validation, changing nothing. */
export const unwiredExecutor: StepExecutor = {
  async validateInstances(steps) {
    const seen = new Map<string, string>();
    for (const s of steps) {
      seen.set(s.source.id, s.source.alias);
      seen.set(s.target.id, s.target.alias);
    }
    return [...seen].map(([instanceId, alias]) => ({ instanceId, alias, message: "Step execution is not connected to the engine in this build." }));
  },
  async runStep() {
    return { status: "error", message: "Step execution is not connected to the engine in this build." };
  },
};

// ---- core-backed executor ----

export type CoreExecutorDeps = {
  instances: Pick<InstanceStore, "get" | "getKeyEnc">;
  secretKey: string;
  /** Injectable for tests; default is core's instance check. */
  check?: (instance: Instance) => Promise<InstanceCheck>;
  /** Injectable for tests; default is core's step runner. */
  run?: (options: CoreStepOptions) => Promise<StepResult>;
  now?: () => Date;
};

const normalizeUrl = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();

/** Replaces any key or URL of a loaded instance in text bound for logs or the browser. */
function redactor(instances: Iterable<Instance>) {
  const secrets = [...instances].flatMap((i) => [[i.apiKey, "[redacted]"], [i.apiUrl, i.alias], [i.apiUrl.replace(/\/+$/, ""), i.alias]] as const).filter(([v]) => v.length > 3);
  return (text: string) => secrets.reduce((t, [v, r]) => t.split(v).join(r), text);
}

/** Roles a step needs from its source and target. */
export function rolesFor(step: RunSettingsStep): { source: Role[]; target: Role[] } {
  const metadata = step.operation === "sync_metadata" || step.options.metadata;
  const source: Role[] = [];
  if (step.operation === "move") source.push("source-move");
  else if (step.operation === "copy" || !metadata) source.push("source-copy");
  if (metadata) source.push("source-metadata");
  return { source, target: metadata ? ["target-metadata"] : ["target-copy"] };
}

/** Converts a step's stored range ("last N days" is relative to the run time) to core's {from?, to}. */
export function coreRange(range: RunSettingsStep["options"]["range"], now: Date): { from?: string; to: string } | undefined {
  if (!range) return undefined;
  if ("lastDays" in range) return { from: new Date(now.getTime() - range.lastDays * 86_400_000).toISOString(), to: now.toISOString() };
  return range;
}

export function createCoreExecutor(deps: CoreExecutorDeps): StepExecutor {
  const check = deps.check ?? checkInstance;
  const run = deps.run ?? coreRunStep;
  const now = deps.now ?? (() => new Date());

  type Loaded = { id: string; instance: Instance } | { id: string; alias: string; problem: string };
  async function load(id: string, alias: string): Promise<Loaded> {
    const [record, enc] = await Promise.all([deps.instances.get(id), deps.instances.getKeyEnc(id)]);
    if (!record || !enc) return { id, alias, problem: "The instance no longer exists." };
    try {
      return { id, instance: { alias: record.alias, apiUrl: record.apiUrl, apiKey: decryptSecret(enc, deps.secretKey) } };
    } catch (err) {
      if (err instanceof DecryptError) return { id, alias: record.alias, problem: "The stored API key cannot be decrypted. Was SECRET_KEY changed? Re-enter the key." };
      throw err;
    }
  }

  return {
    async validateInstances(steps, ctx) {
      const aliases = new Map<string, string>();
      for (const s of steps) {
        aliases.set(s.source.id, s.source.alias);
        aliases.set(s.target.id, s.target.alias);
      }
      const problems: InstanceProblem[] = [];
      const fail = (instanceId: string, alias: string, message: string) => problems.push({ instanceId, alias, message });

      const loaded = new Map<string, Instance>();
      for (const l of await Promise.all([...aliases].map(([id, alias]) => load(id, alias)))) {
        if ("problem" in l) fail(l.id, l.alias, l.problem);
        else loaded.set(l.id, l.instance);
      }
      const redact = redactor(loaded.values());

      // Every instance is checked before step 1, in parallel; nothing is changed.
      const checks = new Map<string, InstanceCheck>();
      await Promise.all(
        [...loaded].map(async ([id, instance]) => {
          let result: InstanceCheck;
          try {
            result = await check(instance);
          } catch (err) {
            return fail(id, instance.alias, redact(`Connection check failed: ${(err as Error).message}`));
          }
          checks.set(id, result);
          if (!result.ok) return fail(id, instance.alias, redact(`${result.error?.stage ?? "check"} check failed: ${result.error?.message ?? "unknown problem"}`));
          await ctx.log({ level: "info", type: "log", message: `${instance.alias}: connected (Immich ${result.version}).`, data: { instanceId: id } });
          for (const w of result.warnings) await ctx.log({ level: "warning", type: "log", message: `${instance.alias}: ${redact(w)}`, data: { instanceId: id } });
        }),
      );

      // Role permissions and the same-server-and-user refusal, per step.
      const seen = new Set<string>();
      const need = (id: string, role: Role, position: number) => {
        const c = checks.get(id);
        const r = c?.roles?.[role];
        if (!c?.ok || !r || r.ok || seen.has(`${id}:${role}`)) return;
        seen.add(`${id}:${role}`);
        fail(id, aliases.get(id)!, `The API key lacks permissions for ${ROLE_LABELS[role]} (step ${position}): ${r.missing.join(", ")}.`);
      };
      for (const s of steps) {
        const roles = rolesFor(s);
        for (const r of roles.source) need(s.source.id, r, s.position);
        for (const r of roles.target) need(s.target.id, r, s.position);
        const a = loaded.get(s.source.id);
        const b = loaded.get(s.target.id);
        const ua = checks.get(s.source.id)?.user?.id;
        const ub = checks.get(s.target.id)?.user?.id;
        if (a && b && ua && ua === ub && normalizeUrl(a.apiUrl) === normalizeUrl(b.apiUrl)) {
          fail(s.target.id, s.target.alias, `Step ${s.position}: source ${s.source.alias} and target ${s.target.alias} are the same server and user.`);
        }
      }
      return problems;
    },

    async runStep(ctx) {
      const { step } = ctx;
      const [src, dst] = await Promise.all([load(step.source.id, step.source.alias), load(step.target.id, step.target.alias)]);
      for (const l of [src, dst]) if ("problem" in l) return { status: "error", message: `${l.alias}: ${l.problem}` };
      const source = (src as { instance: Instance }).instance;
      const target = (dst as { instance: Instance }).instance;
      const redact = redactor([source, target]);

      // Core calls onEvent synchronously; a chain keeps the persisted order, and a log failure never fails the step.
      let queue: Promise<unknown> = Promise.resolve();
      const emit = (ev: NewEvent) => void (queue = queue.then(() => ctx.log(ev)).catch(() => undefined));
      const o = step.options;
      const onEvent = (ev: StepEvent) => {
        const e = ev as { type?: string } & Record<string, unknown>;
        switch (e.type) {
          case "phase":
            return emit({ level: "info", type: "log", message: redact(String(e.message ?? e.phase)), data: { step: step.position, phase: e.phase } });
          case "warning":
            return emit({ level: "warning", type: "log", message: redact(String(e.message)), data: { step: step.position } });
          case "error":
            return emit({ level: "error", type: "log", message: redact(String(e.message)), data: { step: step.position } });
          case "asset": {
            const a = (ev as Extract<StepEvent, { type: "asset" }>).asset;
            const level = a.outcome === "failed" ? "error" : a.outcome === "in-target-trash" || a.outcome === "cancelled" ? "warning" : "info";
            emit({ level, type: "asset", message: redact(`${a.fileName}: ${a.outcome}${a.message ? ` (${a.message})` : ""}`), data: { step: step.position, asset: { ...a, message: a.message ? redact(a.message) : undefined } } });
            return;
          }
          case "progress": {
            const p = ev as Extract<StepEvent, { type: "progress" }>;
            const { type: _t, ...rest } = p;
            return emit({ level: "info", type: "progress", data: { step: step.position, ...rest } });
          }
          case "summary":
            return; // the run manager records the step outcome (with this summary) as the step's summary event
          default:
            // An event kind this build does not know: keep a trace, never fail.
            return emit({ level: "debug", type: "log", message: `Engine event: ${String(e.type)}`, data: { step: step.position } });
        }
      };

      let result: StepResult;
      try {
        result = await run({
          source,
          target,
          operation: step.operation,
          range: coreRange(o.range, now()),
          kind: o.kind,
          metadata: step.operation === "sync_metadata" ? true : o.metadata,
          includeAlbums: o.includeAlbums === true,
          createMissingAlbums: o.createMissingAlbums === true,
          includeTags: o.includeTags === true,
          dryRun: ctx.dryRun,
          signal: ctx.signal,
          onEvent,
        });
      } catch (err) {
        await queue;
        return { status: "error", message: redact((err as Error).message || "Step failed.") };
      }
      await queue;
      return {
        status: result.status,
        summary: { ...result.summary, dryRun: result.dryRun, sourceVersion: result.sourceVersion ?? null, targetVersion: result.targetVersion ?? null, warnings: result.warnings.map(redact) },
        message: result.error ? redact(result.error) : undefined,
      };
    },
  };
}
