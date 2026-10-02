import { capabilitySchema, validateValues, type Capability } from "../contracts/capability.js";
import { authorizeStep, reviewedTarget, type TenantProfile } from "../replay/policy.js";
import type { DiscoverySurface } from "./ports.js";
import { RunError, type EvidenceSink, type InterventionHandler, type FailureCode } from "../replay/ports.js";
import { HandoffCoordinator } from "../replay/handoff.js";
import { decisionSchema, type ModelAdapter } from "./model.js";
import { DiscoveryError, discoveryFailure } from "./errors.js";
import { transformOutput, validateOutputs } from "../contracts/outputs.js";

export function draftCapability(tenant: TenantProfile): Capability {
  return capabilitySchema.parse({ schemaVersion: "1.0",
    capability: { id: "member.read-savings-balance", version: "1.0.0", status: "draft", description: "Read a synthetic member savings balance." },
    compatibility: { appFamily: tenant.appFamily, appVersions: [tenant.appVersion], surface: "web", requiredFeatures: ["structured_targets"] },
    inputs: { memberId: { type: "string", description: "Member identifier", sensitive: true, format: "member_id", maxLength: 5 } },
    outputs: { balance: { type: "string", description: "Savings balance in USD", sensitive: true, format: "decimal_money", maxLength: 30 } },
    targets: { page: { description: "Main application area", robustness: "Unique main landmark", framePath: [], strategies: [{ kind: "css", selector: "main" }] } },
    policy: { allowedRoutes: tenant.routes, allowedActions: ["navigate", "click", "type"], maximumRisk: "reversible" },
    steps: [{ id: "open", description: "Open entry page", action: "navigate", path: "/", risk: "read_only", timeoutMs: 5000,
      preconditions: [], postconditions: [{ kind: "visible", target: "page" }], retry: { maxAttempts: 1, on: [], repeatSafe: false } }],
    outcomes: [], checkpoint: [{ kind: "visible", target: "page" }], extract: [{ output: "balance", target: "page", transform: "usd_money_to_decimal" }],
    metadata: { source: "hand_authored", createdAt: new Date().toISOString() }
  });
}

export async function discover(options: {
  runId: string; memberId: string; tenant: TenantProfile; model: ModelAdapter; evidence: EvidenceSink;
  createSurface: (draft: Capability) => DiscoverySurface; maxSteps?: number;
  intervention?: InterventionHandler;
  /** Fresh-session model-free verification; declared human checkpoints may use an operator. */
  verifyArtifact?: (artifact: Capability) => Promise<boolean>;
}): Promise<Capability> {
  const draft = draftCapability(options.tenant);
  const inputs = validateValues(draft.inputs, { memberId: options.memberId });
  const surface = options.createSurface(draft);
  const deadline = Date.now() + (options.intervention ? 300000 : 120000);
  let interventions = 0;
  let currentIndex = 0;
  let invalidSelections = 0;
  const repeated = new Map<string, number>();
  const history: Array<{ action: string; reason: string }> = [];
  const intervene = async (reason: FailureCode, index: number) => {
    if (!options.intervention || !HandoffCoordinator.eligible(reason)) throw new RunError(reason, "Discovery requires an operator.");
    if (++interventions > 2) throw new RunError("recovery_exhausted", "Discovery intervention budget exhausted.");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new RunError("timeout", "Discovery deadline exceeded.");
    await new HandoffCoordinator().run({ surface, handler: options.intervention, timeoutMs: remaining,
      saveDiagnostic: (value, purpose) => options.evidence.diagnostic(value, purpose),
      context: { runId: options.runId, capabilityId: draft.capability.id, stepId: `discovery-${index}`, reason, phase: "discovery" },
      audit: async (phase, code, manualAction, intervention) => { await options.evidence.append({ phase, stepIndex: index, code,
        ...(manualAction ? { manualAction } : {}), ...(intervention ? { intervention } : {}) }); } });
    history.push({ action: "human_intervention", reason: "reobserve_current_state" });
    await options.evidence.append({ phase: "completed", stepIndex: index, code: "discovery_resumed" });
  };
  try {
    await surface.start();
    await options.evidence.append({ phase: "intent", stepIndex: 0, code: "discovery_entry" });
    authorizeStep(draft.steps[0]!, options.tenant, draft);
    try { await surface.act(draft.steps[0]!, inputs); }
    catch (error) {
      if (!(error instanceof RunError) || !HandoffCoordinator.eligible(error.code)) throw error;
      await intervene(error.code, 0);
    }
    for (let index = 1; index <= (options.maxSteps ?? 12); index++) {
      currentIndex = index;
      if (Date.now() >= deadline) throw new RunError("timeout", "Discovery deadline exceeded.");
      let observation;
      try { observation = await surface.observe(); }
      catch (error) {
        if (!(error instanceof RunError) || !HandoffCoordinator.eligible(error.code)) throw error;
        await intervene(error.code, index);
        continue;
      }
      // Raw observations remain in memory and are sent only for the synthetic demo.
      let response: unknown;
      try { response = await options.model.decide({ inputs: ["memberId"], history,
        controls: observation.map(({ id, text, tag, filled }) => ({ id, text, tag, filled })) },
        AbortSignal.timeout(Math.max(1, Math.min(30000, deadline - Date.now())))); }
      catch { throw new DiscoveryError("model_request_failed"); }
      const parsed = decisionSchema.safeParse(response);
      if (!parsed.success) throw new DiscoveryError("invalid_decision");
      const decision = parsed.data;
      if (Date.now() >= deadline) throw new RunError("timeout", "Discovery deadline exceeded before action.");
      await options.evidence.append({ phase: "intent", stepIndex: index, code: `model_${decision.action}_${decision.reason}` });
      if (decision.action === "stop") {
        await intervene("checkpoint_failed", index);
        continue;
      }
      const selected = observation.find(item => item.id === decision.target);
      if (!selected) {
        await options.evidence.append({ phase: "completed", stepIndex: index, code: "invalid_target_rejected" });
        history.push({ action: "rejected_no_action", reason: "unknown_control_choose_current_observation_id" });
        if (++invalidSelections === 1) {
          await options.evidence.append({ phase: "intent", stepIndex: index, code: "target_selection_retry" });
          continue; // A new observation and decision, never a retry of a UI action.
        }
        if (!options.intervention) throw new DiscoveryError("unknown_control");
        await intervene("target_missing", index);
        invalidSelections = 0;
        continue;
      }
      invalidSelections = 0;
      const targetId = `target${index}`;
      // Only reviewed static descriptors cross the artifact persistence boundary.
      const safeTarget = reviewedTarget(selected.target, options.tenant);
      if (!safeTarget) throw new DiscoveryError("sensitive_target");
      draft.targets[targetId] = safeTarget;
      // Observed next target is a stronger previous-step postcondition than a page landmark.
      draft.steps.at(-1)!.postconditions = [{ kind: "visible", target: targetId }];
      if (decision.action === "finish") {
        if (selected.tag !== "td" || !selected.target.strategies.some(strategy => strategy.kind === "css" && strategy.selector.includes('"Current balance"'))) throw new DiscoveryError("invalid_finish_target");
        const identity = observation.find(item => item.tag === "p" && item.text.includes(options.memberId));
        if (!identity) throw new DiscoveryError("identity_unverified");
        const safeIdentity = reviewedTarget(identity.target, options.tenant);
        if (!safeIdentity) throw new DiscoveryError("sensitive_target");
        draft.targets.memberIdentity = safeIdentity;
        draft.checkpoint = [{ kind: "visible", target: targetId }, { kind: "text_contains_input", target: "memberIdentity", input: "memberId" }];
        const value = await surface.read(targetId);
        for (const condition of draft.checkpoint) if (!await surface.matches(condition, inputs)) throw new RunError("checkpoint_failed", "Final checkpoint failed.");
        draft.extract = [{ output: "balance", target: targetId, transform: "usd_money_to_decimal" }];
        draft.steps.at(-1)!.postconditions = draft.checkpoint;
        // Supplied demo-domain outcome detector; not claimed to have been discovered on the happy path.
        draft.targets.notFound = { description: "Known demo business outcome", robustness: "Exact reviewed application message", framePath: [],
          strategies: [{ kind: "text", text: "Member not found. Check the member ID and try again.", exact: true }] };
        const clickIds = draft.steps.filter(step => step.action === "click").map(step => step.id);
        if (clickIds.length) draft.outcomes = [{ code: "member_not_found", description: "Known demo outcome supplied by the application contract", when: [{ kind: "visible", target: "notFound" }], afterSteps: clickIds }];
        draft.targets.validationRejected = { description: "Known demo validation outcome", robustness: "Exact reviewed application message", framePath: [],
          strategies: [{ kind: "text", text: "Lookup rejected by application validation.", exact: true }] };
        if (clickIds.length) draft.outcomes.push({ code: "validation_rejected", description: "Application rejected lookup; no automatic retry",
          when: [{ kind: "visible", target: "validationRejected" }], afterSteps: clickIds });
        draft.metadata = options.model.provenance === "live_llm" ?
          { source: "llm_discovery", createdAt: new Date().toISOString(), discoveryRunId: options.runId } :
          { source: "hand_authored", createdAt: new Date().toISOString() };
        const artifact = capabilitySchema.parse(draft);
        try { validateOutputs(artifact, { balance: transformOutput(value, "usd_money_to_decimal") }); }
        catch { throw new DiscoveryError("invalid_balance"); }
        if (interventions > 0) {
          await options.evidence.append({ phase: "completed", stepIndex: index, code: "assisted_goal_verified" });
          await options.evidence.append({ phase: "intent", stepIndex: index, code: "assisted_artifact_verification" });
          if (!options.verifyArtifact || !await options.verifyArtifact(artifact)) {
            throw new DiscoveryError("artifact_verification_failed");
          }
          await options.evidence.append({ phase: "completed", stepIndex: index, code: "assisted_artifact_verified" });
        }
        await options.evidence.append({ phase: "result", stepIndex: index, code: "discovery_verified" });
        return artifact;
      }
      if (decision.action === "type" && (selected.tag !== "input" || decision.input !== "memberId")) throw new DiscoveryError("invalid_type_reference");
      if (decision.action === "click" && !["button", "a"].includes(selected.tag)) throw new DiscoveryError("invalid_click_target");
      const fingerprint = JSON.stringify({ action: decision.action, target: selected.target });
      const count = (repeated.get(fingerprint) ?? 0) + 1; repeated.set(fingerprint, count);
      if (count > 2) {
        await intervene("checkpoint_failed", index);
        continue;
      }
      const common = { id: `step${index}`, description: "Observed and executed discovery action", timeoutMs: 5000,
        preconditions: [{ kind: "visible" as const, target: targetId }], postconditions: [{ kind: "visible" as const, target: "page" }],
        retry: { maxAttempts: 1, on: [], repeatSafe: false } };
      const step: Capability["steps"][number] = decision.action === "type" ?
        { ...common, action: "type", target: targetId, input: "memberId", risk: "reversible" } :
        { ...common, action: "click", target: targetId, risk: "reversible" };
      authorizeStep(step, options.tenant, draft);
      try { await surface.act(step, inputs); }
      catch (error) {
        if (!(error instanceof RunError) || !HandoffCoordinator.eligible(error.code)) throw error;
        await intervene(error.code, index);
        if (error.code === "operator_required") {
          step.humanCheckpoint = { reason: "operator_required",
            instructions: "Resolve the operator-only state, then resume; the step postconditions must pass." };
          draft.schemaVersion = "1.1";
          draft.capability.version = "1.1.0";
          if (!draft.compatibility.requiredFeatures.includes("manual_control")) draft.compatibility.requiredFeatures.push("manual_control");
        }
      }
      draft.steps.push(step);
      history.push({ action: decision.action, reason: decision.reason });
      for (const code of surface.drainRecoveries?.() ?? []) await options.evidence.append({ phase: "completed", stepIndex: index, code });
      await options.evidence.append({ phase: "completed", stepIndex: index, code: `discovery_${step.action}` });
    }
    throw new DiscoveryError("step_limit");
  } catch (error) {
    try { await options.evidence.diagnostic(await surface.diagnostics()); } catch { /* Preserve original failure if capture or storage fails. */ }
    try { await options.evidence.append({ phase: "result", stepIndex: currentIndex, code: `discovery_failed_${discoveryFailure(error).code}` }); } catch { /* Preserve original failure. */ }
    throw error;
  } finally { try { await surface.close(); } catch { /* Cleanup must not mask discovery outcome. */ } }
}
