import { RunError, type EvidenceSink, type FailureCode, type InterventionHandler, type SurfaceAdapter } from "./ports.js";
import type { ManualAction } from "./diagnostic-schema.js";

export type HandoffState = "idle" | "requested" | "human" | "resuming" | "resolved" | "aborted";
type Audit = (phase: "intent" | "completed" | "result", code: string, action?: ManualAction,
  intervention?: Parameters<EvidenceSink["append"]>[0]["intervention"]) => Promise<void>;

/** One intervention lifecycle. Browser and operator implementations remain injected ports. */
export class HandoffCoordinator {
  private current: HandoffState = "idle";
  get state(): HandoffState { return this.current; }

  static eligible(code: FailureCode): boolean {
    return ["checkpoint_failed", "timeout", "target_missing", "session_expired", "operator_required"].includes(code);
  }

  async run(options: {
    surface: Pick<SurfaceAdapter, "diagnostics" | "beginManual" | "endManual">; handler: InterventionHandler; audit: Audit; timeoutMs: number;
    saveDiagnostic: EvidenceSink["diagnostic"];
    context: { runId: string; capabilityId: string; stepId: string; reason: FailureCode; phase?: "discovery" | "replay"; conditionContext?: string };
  }): Promise<void> {
    if (this.current !== "idle") throw new RunError("internal_error", "Intervention lifecycle cannot be reused.");
    if (!HandoffCoordinator.eligible(options.context.reason)) throw new RunError("policy_denied", "This failure cannot be overridden by an operator.");
    const { surface, handler, audit } = options;
    if (!surface.beginManual || !surface.endManual) throw new RunError("incompatible_surface", "Surface does not support manual control.");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let entered = false;
    try {
      this.current = "requested";
      const diagnostic = await surface.diagnostics();
      const reference = await options.saveDiagnostic(diagnostic, "intervention");
      await audit("intent", "intervention_requested", undefined, {
        reason: options.context.reason, stepId: options.context.stepId, diagnostic: reference
      });
      const state = { surface: diagnostic.surface, sessionOpen: diagnostic.sessionOpen, controlCount: diagnostic.controlCount };
      if (!state.sessionOpen) throw new RunError("app_error", "Cannot transfer a lost session.");
      await surface.beginManual((code, action) => audit("completed", code, action));
      entered = true;
      this.current = "human";
      await audit("completed", "control_human");
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new RunError("timeout", "Human intervention deadline exceeded.")); }, Math.max(1, options.timeoutMs));
      });
      const decision = await Promise.race([handler.request({ ...options.context, state, deadlineAt: Date.now() + options.timeoutMs }, controller.signal), expired]);
      if (controller.signal.aborted) throw new RunError("timeout", "Human intervention deadline exceeded.");
      if (decision !== "resume") throw new RunError("human_aborted", "Operator aborted the live run.");
      this.current = "resuming";
      await audit("completed", "control_resuming");
      entered = false;
      await surface.endManual();
      this.current = "resolved";
      // Caller must still verify workflow postconditions; control transfer is not workflow success.
    } catch (error) {
      this.current = "aborted";
      if (entered) {
        try { await surface.endManual(); } catch { /* Preserve primary abort/audit/deadline failure. Caller closes session. */ }
      }
      throw error;
    } finally {
      controller.abort();
      if (timer) clearTimeout(timer);
    }
  }
}
