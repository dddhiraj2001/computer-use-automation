import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { replay } from "./replay/engine.js";
import { WebSurface } from "./replay/web-surface.js";
import { FileEvidence } from "./replay/evidence.js";
import { tenantProfileSchema } from "./replay/policy.js";

// Explicitly synthetic, offline-model release receipt. Never persist caller output values.
const artifactPath = "evidence/artifacts/discovery-e4e4d137-255d-4366-89eb-853b6babd9f4.json";
const artifact: unknown = JSON.parse(await readFile(artifactPath, "utf8"));
const tenant = tenantProfileSchema.parse(JSON.parse(await readFile("config/tenants/northstar.json", "utf8")));
if (tenant.origin !== "http://127.0.0.1:3000" || tenant.appFamily !== "northstar-demo") throw new Error("Evidence verification is restricted to the local synthetic fixture.");
for (const [memberId, expected] of [["23456", "success"], ["99999", "business_outcome"]] as const) {
  const runId = `release-${randomUUID()}`;
  const result = await replay({ runId, artifact, tenant, inputs: { memberId },
    evidence: new FileEvidence("evidence/release", tenant.id, runId), createSurface: (cap, profile) => new WebSurface(cap, profile) });
  const passed = result.status === expected && (result.status !== "business_outcome" || result.code === "member_not_found");
  const receipt = { format: "verification-receipt-v1", runId, artifactPath, modelUsed: false, passed,
    status: result.status,
    ...(result.status === "success" ? { checkpointVerified: result.checkpointVerified, outputNames: Object.keys(result.outputs), outputValuesOmitted: true }
      : { code: result.code }) };
  const directory = resolve("evidence/release", tenant.id, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(receipt));
  if (!passed) process.exitCode = 1;
}
