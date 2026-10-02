import type { Capability } from "../contracts/capability.js";
import type { z } from "zod";
import type { failureCodeSchema } from "../contracts/results.js";
import type { ManualAction, SurfaceDiagnostic } from "./diagnostic-schema.js";
export type FailureCode = z.infer<typeof failureCodeSchema>;
export type Step = Capability["steps"][number];
export type Condition = Capability["checkpoint"][number];
export type Values = Record<string, string | number | boolean>;
export class RunError extends Error {
  constructor(readonly code: FailureCode, message: string) { super(message); }
}
export interface SurfaceAdapter {
  readonly features: readonly string[];
  start(): Promise<void>;
  act(step: Step, inputs: Values): Promise<void>;
  matches(condition: Condition, inputs: Values): Promise<boolean>;
  read(target: string): Promise<string>;
  drainRecoveries?(): string[];
  diagnostics(): Promise<SurfaceDiagnostic>;
  close(): Promise<void>;
  beginManual?(record: (code: string, action?: ManualAction) => Promise<void>): Promise<void>;
  endManual?(): Promise<void>;
}
export interface InterventionHandler {
  request(context: { runId: string; capabilityId: string; stepId: string; reason: FailureCode;
    phase?: "discovery" | "replay";
    deadlineAt?: number;
    conditionContext?: string;
    state: { surface: string; sessionOpen: boolean; controlCount: number } }, signal: AbortSignal): Promise<"resume" | "abort">;
}
export interface EvidenceSink {
  append(event: { phase: "intent" | "completed" | "result"; stepIndex: number | null; code: string; manualAction?: ManualAction;
    intervention?: { reason: FailureCode; stepId: string; diagnostic: string } }): Promise<void>;
  diagnostic(value: SurfaceDiagnostic, purpose?: "intervention"): Promise<string>;
}
