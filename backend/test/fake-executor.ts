import type { ExecutionContext, InstanceProblem, StepContext, StepExecutor, StepOutcome } from "../src/runs/executor.ts";
import type { RunSettingsStep } from "../src/runs/store.ts";

/** Scriptable executor: outcomes by step position, optional gate to hold a step, records every call. */
export class FakeExecutor implements StepExecutor {
  calls: Array<{ kind: "validate" | "step"; position?: number; dryRun?: boolean }> = [];
  problems: InstanceProblem[] = [];
  outcomes = new Map<number, StepOutcome | Error>();
  /** Steps listed here wait until released (or abort) before returning. */
  gates = new Map<number, Promise<void>>();
  started = new Map<number, () => void>();
  /** The abort signal of every runStep call, in call order. */
  signals: AbortSignal[] = [];
  /** When set, a gated step waits for its gate only, as if it did not notice cancellation. */
  ignoreAbort = false;
  private startedPromises = new Map<number, Promise<void>>();

  /** Resolves once the step has begun running. */
  hasStarted(position: number): Promise<void> {
    if (!this.startedPromises.has(position)) this.startedPromises.set(position, new Promise((r) => this.started.set(position, r)));
    return this.startedPromises.get(position)!;
  }

  async validateInstances(_steps: readonly RunSettingsStep[], _ctx: ExecutionContext) {
    this.calls.push({ kind: "validate" });
    return this.problems;
  }

  async runStep(ctx: StepContext): Promise<StepOutcome> {
    this.calls.push({ kind: "step", position: ctx.position, dryRun: ctx.dryRun });
    this.signals.push(ctx.signal);
    const gate = this.gates.get(ctx.position);
    const outcome = this.outcomes.get(ctx.position);
    this.hasStarted(ctx.position);
    this.started.get(ctx.position)?.();
    await ctx.log({ level: "info", type: "progress", message: `working ${ctx.position}`, data: { done: 1, total: 2 } });
    if (gate) {
      if (this.ignoreAbort) await gate;
      else await Promise.race([gate, new Promise<void>((r) => (ctx.signal.aborted ? r() : ctx.signal.addEventListener("abort", () => r(), { once: true })))]);
      if (ctx.signal.aborted && !outcome) return { status: "cancelled", summary: { transferred: 1 } };
    }
    const o = outcome ?? { status: "completed", summary: { found: 2, transferred: 2 } };
    if (o instanceof Error) throw o;
    return o;
  }
}
