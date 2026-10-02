import { z } from "zod";
import { recoveryCodeSchema, validateValues, type Capability } from "./capability.js";

const text = z.string().min(1).max(2000);
const identity = { runId: text, capabilityId: text, capabilityVersion: text };
export const failureCodeSchema = z.enum([
  "invalid_input", "policy_denied", "permission_denied", "session_expired",
  "unexpected_dialog", "target_missing", "target_ambiguous", "timeout",
  "app_error", "checkpoint_failed", "output_invalid", "incompatible_surface",
  "recovery_exhausted", "human_aborted", "internal_error", "operator_required"
]);

export const replayResultSchema = z.discriminatedUnion("status", [
  z.object({ ...identity, status: z.literal("success"), checkpointVerified: z.literal(true),
    outputs: z.record(z.union([z.string(), z.number().finite(), z.boolean()])) }).strict(),
  z.object({ ...identity, status: z.literal("business_outcome"), code: text }).strict(),
  z.object({ ...identity, status: z.literal("failure"), code: failureCodeSchema,
    stepId: text.nullable(), stepIndex: z.number().int().nonnegative().nullable(),
    expected: text, observedRedacted: text,
    evidence: z.array(text), interventionAvailable: z.boolean(),
    retries: z.array(z.object({ attempt: z.number().int().positive(), code: recoveryCodeSchema }).strict())
  }).strict()
]);

export type ReplayResult = z.infer<typeof replayResultSchema>;

export function validateReplayResult(capability: Capability, value: unknown): ReplayResult {
  const result = replayResultSchema.parse(value);
  if (result.capabilityId !== capability.capability.id || result.capabilityVersion !== capability.capability.version) {
    throw new Error("Result does not belong to this capability version");
  }
  if (result.status === "success") validateValues(capability.outputs, result.outputs);
  if (result.status === "business_outcome" && !capability.outcomes.some((outcome) => outcome.code === result.code)) {
    throw new Error("Undeclared business outcome");
  }
  if (result.status === "failure") {
    if ((result.stepId === null) !== (result.stepIndex === null)) throw new Error("Step ID and index must both be null or both be present");
    if (result.stepIndex !== null && capability.steps[result.stepIndex]?.id !== result.stepId) {
      throw new Error("Failure step does not match artifact");
    }
  }
  return result;
}

export const eventSchema = z.object({
  timestamp: z.string().datetime(), runId: text,
  actor: z.enum(["model", "automation", "human"]),
  phase: z.enum(["discovery", "replay", "handoff"]),
  kind: z.enum(["observation", "action", "policy_decision", "recovery", "intervention", "control_transfer", "result"]),
  stepId: text.nullable(), summaryRedacted: text,
  reasonRedacted: text, evidence: z.array(text)
}).strict();

export const interventionSchema = z.object({
  id: text, runId: text, sessionId: text, goalRedacted: text,
  capabilityId: text.nullable(), stepId: text.nullable(),
  reason: z.enum(["stuck", "recovery_exhausted", "approval_required"]),
  stateRedacted: text, evidence: z.array(text),
  owner: z.enum(["automation", "human", "none"]),
  state: z.enum(["requested", "human_active", "resuming", "resolved", "aborted"]),
  createdAt: z.string().datetime()
}).strict();
