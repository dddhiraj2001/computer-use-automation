import { capabilitySchema, validateValues, type Capability } from "../contracts/capability.js";
import { replayResultSchema, validateReplayResult, type ReplayResult } from "../contracts/results.js";
import { authorizeStep, specialize, tenantProfileSchema, type TenantProfile } from "./policy.js";
import { RunError, type EvidenceSink, type SurfaceAdapter, type Values, type Condition, type InterventionHandler } from "./ports.js";
import { HandoffCoordinator } from "./handoff.js";
import type { ManualAction } from "./diagnostic-schema.js";
import { transformOutput, validateOutputs } from "../contracts/outputs.js";

export interface ReplayOptions {
  runId: string; artifact: unknown; inputs: unknown; tenant: unknown;
  createSurface: (capability: Capability, tenant: TenantProfile) => SurfaceAdapter;
  evidence: EvidenceSink; timeoutMs?: number;
  intervention?: InterventionHandler;
}
/** Interprets capability data without importing browsers, filesystem, or model clients. */
export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  let capability: Capability | undefined;
  let surface: SurfaceAdapter | undefined;
  let index: number | null = null;
  let stage = "preflight";
  const retries: Array<{ attempt: number; code: "transient_timeout" }> = [];
  const identity = () => ({ runId: options.runId, capabilityId: capability?.capability.id ?? "unvalidated",
    capabilityVersion: capability?.capability.version ?? "unvalidated" });
  const deadline = Date.now() + Math.min(Math.max(options.timeoutMs ?? 60000, 100), 300000);
  const remaining = () => {
    const time = deadline - Date.now();
    if (time <= 0) throw new RunError("timeout", "Run deadline exceeded.");
    return time;
  };
  const audit = async (phase: "intent" | "completed" | "result", code: string, manualAction?: ManualAction,
    intervention?: Parameters<EvidenceSink["append"]>[0]["intervention"]) => {
    try { await options.evidence.append({ phase, stepIndex: index, code, ...(manualAction ? { manualAction } : {}), ...(intervention ? { intervention } : {}) }); }
    catch { throw new RunError("internal_error", "Required audit persistence failed; execution stopped."); }
  };
  try {
    capability = capabilitySchema.parse(options.artifact);
    const tenant = tenantProfileSchema.parse(options.tenant);
    capability = specialize(capability, tenant);
    const inputs = validateValues(capability.inputs, options.inputs);
    if (capability.steps.some(step => step.humanCheckpoint) && !options.intervention) {
      throw new RunError("operator_required", "This capability requires an operator; enable human handoff before starting.");
    }
    surface = options.createSurface(capability, tenant);
    if (!capability.compatibility.requiredFeatures.every(feature => surface!.features.includes(feature))) {
      throw new RunError("incompatible_surface", "Adapter does not provide required features.");
    }
    stage = "session";
    await audit("intent", "session_start");
    await surface.start();
    remaining();
    for (const [i, step] of capability.steps.entries()) {
      index = i;
      stage = "step";
      authorizeStep(step, tenant, capability);
      try {
      await waitConditions(surface, step.preconditions, inputs, Math.min(step.timeoutMs, remaining()), "precondition");
      for (let attempt = 1; ; attempt++) {
        await audit("intent", step.action);
        try {
          await surface.act({ ...step, timeoutMs: Math.min(step.timeoutMs, remaining()) }, inputs);
          for (const recovery of surface.drainRecoveries?.() ?? []) await audit("completed", recovery);
          break;
        } catch (error) {
          // Only observation waits may repeat automatically in this implementation.
          const safe = step.action === "wait" && step.retry.repeatSafe && step.retry.on.includes("transient_timeout");
          if (!(error instanceof RunError) || error.code !== "timeout" || !safe) throw error;
          if (attempt >= step.retry.maxAttempts) throw new RunError("recovery_exhausted", "Recovery budget exhausted.");
          retries.push({ attempt, code: "transient_timeout" });
          remaining();
        }
      }
      await audit("completed", step.action);
      if (step.humanCheckpoint) throw new RunError("operator_required", step.humanCheckpoint.instructions);
      const outcomes = capability.outcomes.filter(outcome => outcome.afterSteps.includes(step.id));
      const end = Date.now() + Math.min(step.timeoutMs, remaining());
      while (true) {
        const matches: string[] = [];
        for (const outcome of outcomes) if (await matchesAll(surface, outcome.when, inputs)) matches.push(outcome.code);
        if (matches.length > 1) throw new RunError("app_error", "Conflicting business outcomes were observed.");
        if (matches[0]) {
          const result = validateReplayResult(capability, { ...identity(), status: "business_outcome", code: matches[0] });
          await audit("result", "business_outcome");
          return result;
        }
        const failed = await firstUnmatched(surface, step.postconditions, inputs);
        if (failed === -1) break;
        if (Date.now() >= end) throw conditionFailure("postcondition", failed, step.postconditions);
        await pause();
      }
      } catch (error) {
        // Never use human takeover to bypass policy, ambiguous targeting, or audit failure.
        if (!(error instanceof RunError) || !HandoffCoordinator.eligible(error.code) ||
            !options.intervention || !surface.beginManual || !surface.endManual) throw error;
        await new HandoffCoordinator().run({ surface, handler: options.intervention, audit, timeoutMs: remaining(),
          saveDiagnostic: (value, purpose) => options.evidence.diagnostic(value, purpose),
          context: { runId: options.runId, capabilityId: capability.capability.id, stepId: step.id, reason: error.code,
            ...(error instanceof ConditionError ? { conditionContext: error.message } : {}) } });
        remaining();
        const manualOutcomes: string[] = [];
        for (const outcome of capability.outcomes.filter(item => item.afterSteps.includes(step.id))) {
          if (await matchesAll(surface, outcome.when, inputs)) manualOutcomes.push(outcome.code);
        }
        if (manualOutcomes.length > 1) throw new RunError("app_error", "Conflicting business outcomes after manual control.");
        if (manualOutcomes[0]) {
          const result = validateReplayResult(capability, { ...identity(), status: "business_outcome", code: manualOutcomes[0] });
          await audit("result", "business_outcome");
          return result;
        }
        // An uncertain action is not retried. Operator must complete this step on the same session.
        const failed = await firstUnmatched(surface, step.postconditions, inputs);
        if (failed !== -1) throw conditionFailure("manual postcondition", failed, step.postconditions);
        await audit("completed", "intervention_resolved");
      }
    }
    stage = "output";
    let outputs: Values;
    // At most one final-stage intervention. Restart only reads/checks, never actions.
    for (let attempt = 0; ; attempt++) {
      try {
        await waitConditions(surface, capability.checkpoint, inputs, Math.min(5000, remaining()), "final checkpoint");
        const candidate: Values = {};
        for (const extraction of capability.extract) {
          remaining();
          candidate[extraction.output] = transformOutput(await surface.read(extraction.target), extraction.transform);
        }
        remaining();
        await waitConditions(surface, capability.checkpoint, inputs, Math.min(5000, remaining()), "post-extraction checkpoint");
        outputs = validateOutputs(capability, candidate);
        break;
      } catch (error) {
        if (attempt > 0 || !(error instanceof RunError) || !HandoffCoordinator.eligible(error.code) ||
            !options.intervention || !surface.beginManual || !surface.endManual) throw error;
        await new HandoffCoordinator().run({ surface, handler: options.intervention, audit, timeoutMs: remaining(),
          saveDiagnostic: (value, purpose) => options.evidence.diagnostic(value, purpose),
          context: { runId: options.runId, capabilityId: capability.capability.id, stepId: "final-output", reason: error.code,
            ...(error instanceof ConditionError ? { conditionContext: error.message } : {}) } });
        await audit("completed", "intervention_resolved");
      }
    }
    const result = validateReplayResult(capability, { ...identity(), status: "success", checkpointVerified: true, outputs });
    await audit("result", "success");
    return result;
  } catch (error) {
    const code = error instanceof RunError ? error.code : stage === "preflight" ? "invalid_input" : stage === "output" ? "output_invalid" : "internal_error";
    const evidence: string[] = [];
    try { if (surface) evidence.push(await options.evidence.diagnostic(await surface.diagnostics())); } catch { /* Preserve the original failure. */ }
    try { await options.evidence.append({ phase: "result", stepIndex: index, code }); } catch { /* Caller still receives the primary failure. */ }
    return replayResultSchema.parse({ ...identity(), status: "failure", code,
      stepId: index === null ? null : capability?.steps[index]?.id ?? null, stepIndex: index,
      expected: `Complete ${stage} within policy and deadline.`,
      observedRedacted: error instanceof RunError ? error.message : "Execution stopped; raw exception data was not persisted.",
      evidence, interventionAvailable: false, retries });
  } finally {
    try { await surface?.close(); } catch { /* Cleanup must not replace the primary result. */ }
  }
}
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 50));
async function matchesAll(surface: SurfaceAdapter, conditions: Condition[], inputs: Values): Promise<boolean> {
  for (const condition of conditions) if (!await surface.matches(condition, inputs)) return false;
  return true;
}
class ConditionError extends RunError {}
function conditionFailure(scope: string, index: number, conditions: Condition[]): ConditionError {
  // Only code-owned scope, numeric position and schema-enumerated kind: never input/text/locator values.
  return new ConditionError("checkpoint_failed", `${scope} ${index + 1} (${conditions[index]!.kind}) did not match. Inspect that condition in the artifact; observed match=false. Values omitted.`);
}
async function firstUnmatched(surface: SurfaceAdapter, conditions: Condition[], inputs: Values): Promise<number> {
  for (const [index, condition] of conditions.entries()) if (!await surface.matches(condition, inputs)) return index;
  return -1;
}
async function waitConditions(surface: SurfaceAdapter, conditions: Condition[], inputs: Values, timeout: number, scope: string): Promise<void> {
  const end = Date.now() + timeout;
  while (true) {
    const failed = await firstUnmatched(surface, conditions, inputs);
    if (failed === -1) return;
    if (Date.now() >= end) throw conditionFailure(scope, failed, conditions);
    await pause();
  }
}
