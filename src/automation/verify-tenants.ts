import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { replay } from "./replay/engine.js";
import { WebSurface } from "./replay/web-surface.js";
import { FileEvidence } from "./replay/evidence.js";
import { tenantProfileSchema } from "./replay/policy.js";

const source = await readFile("evidence/artifacts/discovery-e4e4d137-255d-4366-89eb-853b6babd9f4.json", "utf8");
const artifact: unknown = JSON.parse(source);
for (const id of ["northstar", "cedar"] as const) {
  const tenant = tenantProfileSchema.parse(JSON.parse(await readFile(`config/tenants/${id}.json`, "utf8")));
  const runId = `tenant-${randomUUID()}`;
  const result = await replay({ runId, artifact, tenant, inputs: { memberId: "23456" },
    evidence: new FileEvidence("evidence/tenants", id, runId), createSurface: (cap, profile) => new WebSurface(cap, profile) });
  const receipt = { runId, tenant: id, artifactSha256: createHash("sha256").update(source).digest("hex"),
    modelUsed: false, status: result.status, checkpointVerified: result.status === "success" && result.checkpointVerified,
    ...(result.status === "failure" ? { code: result.code } : {}), outputValuesOmitted: true };
  const directory = `evidence/tenants/${id}/${runId}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(`${directory}/receipt.json`, JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(receipt));
  if (result.status !== "success") process.exitCode = 1;
}
