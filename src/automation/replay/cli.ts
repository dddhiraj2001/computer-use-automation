import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { replay } from "./engine.js";
import { tenantProfileSchema } from "./policy.js";
import { WebSurface } from "./web-surface.js";
import { FileEvidence } from "./evidence.js";
import { TerminalOperator } from "./terminal-operator.js";
import { trackedRun } from "../catalog/tracked-run.js";
import { capabilitySchema } from "../contracts/capability.js";

const artifactPath = process.argv[2] ?? "examples/member-balance.capability.json";
const memberId = process.env.MEMBER_ID;
if (!memberId) {
  console.error("Set MEMBER_ID to one of the synthetic five-digit demo IDs.");
  process.exitCode = 2;
} else {
  try {
    const artifact = capabilitySchema.parse(JSON.parse(await readFile(artifactPath, "utf8")));
    const tenant = tenantProfileSchema.parse(JSON.parse(await readFile(process.env.TENANT_PROFILE ?? "config/tenants/northstar.json", "utf8")) as unknown);
    const runId = `replay-${randomUUID()}`;
    const result = await trackedRun({ runId, tenant: tenant.id, capability: artifact.capability.id, version: artifact.capability.version }, () => replay({ runId, artifact, inputs: { memberId }, tenant,
      ...(process.env.HUMAN_HANDOFF === "true" ? { intervention: new TerminalOperator() } : {}),
      timeoutMs: process.env.HUMAN_HANDOFF === "true" ? 300000 : 60000,
      evidence: new FileEvidence("evidence/runs", tenant.id, runId),
      createSurface: (capability, profile) => new WebSurface(capability, profile, process.env.HUMAN_HANDOFF !== "true" && process.env.HEADLESS !== "false") }), result => result.status);
    console.log(result.status === "success" ? "Lookup completed. The requested member and balance were verified."
      : result.status === "business_outcome" ? `Lookup finished with a business outcome: ${result.code}.`
      : result.code === "timeout" ? "Lookup stopped because its time limit expired. Start a new run when ready."
      : result.code === "human_aborted" ? "Lookup cancelled by the operator."
      : `Lookup did not complete (${result.code}). Review the step and evidence below; do not assume the action succeeded.`);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "failure") process.exitCode = 1;
  } catch {
    console.error("Could not validate the capability or run the local demo. Check that the server is running and configuration is valid.");
    process.exitCode = 1;
  }
}
