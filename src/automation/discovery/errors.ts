import { RunError } from "../replay/ports.js";

const guidance = {
  artifact_verification_failed: "Live goal completed, but independent replay did not verify the artifact. No capability was saved. Check the verification run evidence.",
  unknown_control: "Model selected an unknown control. No action was executed; retry discovery with a fresh observation.",
  sensitive_target: "Target descriptor is not in the trusted static control catalog. No artifact was saved; review the application profile before retrying.",
  invalid_type_reference: "Typing decision has an invalid input reference or control. Expected memberId and an input control; no typing was executed.",
  invalid_click_target: "Click target is not an interactive control. No click was executed.",
  invalid_finish_target: "Finish target is not a savings balance field. No artifact was saved.",
  identity_unverified: "Member identity could not be verified. No artifact was saved.",
  invalid_balance: "Output is not a valid balance. No artifact was saved.",
  invalid_decision: "Model returned an invalid decision shape. No proposed action was executed.",
  model_request_failed: "Model request failed. Check provider access, billing, model configuration and connectivity; raw details were withheld.",
  step_limit: "Discovery step limit exceeded. Review the safe event log before retrying.",
} as const;

export class DiscoveryError extends Error {
  constructor(readonly code: keyof typeof guidance) {
    super(guidance[code]);
    this.name = "DiscoveryError";
  }
}

/** Only our typed categories cross the diagnostic boundary, never arbitrary messages. */
export function discoveryFailure(error: unknown): { code: string; guidance: string } {
  if (error instanceof DiscoveryError) return { code: error.code, guidance: guidance[error.code] };
  if (error instanceof RunError) return { code: error.code, guidance: "The UI run stopped safely. Review the current step and redacted diagnostic." };
  return { code: "internal_error", guidance: "An unclassified failure occurred. Check local application and configuration; raw details were withheld." };
}
