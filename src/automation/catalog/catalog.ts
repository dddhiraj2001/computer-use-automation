import { z } from "zod";
import { capabilitySchema, validateValues, type Capability } from "../contracts/capability.js";
import { tenantProfileSchema, type TenantProfile } from "../replay/policy.js";
import type { ReplayResult } from "../contracts/results.js";
import { LocalAuthorization } from "./authorization.js";

const callSchema = z.object({ name: z.string().min(1).max(100), version: z.string().max(30), args: z.record(z.unknown()) }).strict();
export type Executor = (artifact: Capability, tenant: TenantProfile, inputs: Record<string, string | number | boolean>) => Promise<ReplayResult>;

/** Trusted host binds one tenant and its grants. Model calls cannot supply paths, tenants or policy. */
export class CapabilityCatalog {
  private readonly entries = new Map<string, Capability>();
  private readonly tenant: TenantProfile;
  private active = false;
  constructor(artifacts: unknown[], tenant: unknown, private readonly execute: Executor,
    private readonly authorization: LocalAuthorization = new LocalAuthorization({ callers: [] }, undefined)) {
    this.tenant = tenantProfileSchema.parse(tenant);
    for (const value of artifacts) {
      const artifact = capabilitySchema.parse(value);
      const key = `${artifact.capability.id}@${artifact.capability.version}`;
      if (this.entries.has(key)) throw new Error("Duplicate capability registration.");
      this.entries.set(key, artifact);
    }
  }
  list() {
    return [...this.entries.values()].filter(artifact => this.authorization.permits(this.tenant.id, artifact.capability.id, artifact.capability.version)).map(artifact => structuredClone({ name: artifact.capability.id,
      version: artifact.capability.version, description: artifact.capability.description,
      inputs: artifact.inputs, outputs: artifact.outputs,
      requiresHuman: artifact.steps.some(step => step.humanCheckpoint) }));
  }
  async invoke(value: unknown): Promise<ReplayResult | { status: "rejected"; code: "invalid_call" | "forbidden" | "unknown_capability" | "invalid_arguments" | "busy" }> {
    const parsed = callSchema.safeParse(value);
    if (!parsed.success) return { status: "rejected", code: "invalid_call" };
    const { name, version, args } = parsed.data;
    if (!this.authorization.permits(this.tenant.id, name, version)) return { status: "rejected", code: "forbidden" };
    const artifact = this.entries.get(`${name}@${version}`);
    if (!artifact) return { status: "rejected", code: "unknown_capability" };
    let inputs;
    try { inputs = validateValues(artifact.inputs, args); }
    catch { return { status: "rejected", code: "invalid_arguments" }; }
    if (this.active) return { status: "rejected", code: "busy" };
    this.active = true;
    try { return await this.execute(structuredClone(artifact), structuredClone(this.tenant), inputs); }
    finally { this.active = false; }
  }
}
