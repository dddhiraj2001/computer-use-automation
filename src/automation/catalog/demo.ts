import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CapabilityCatalog } from "./catalog.js";
import { replay } from "../replay/engine.js";
import { WebSurface } from "../replay/web-surface.js";
import { FileEvidence } from "../replay/evidence.js";
import { LocalAuthorization } from "./authorization.js";
import { RunLedger } from "./run-ledger.js";

// Trusted host registration, not caller-selected file paths or origins.
const artifact = JSON.parse(await readFile("evidence/artifacts/discovery-e4e4d137-255d-4366-89eb-853b6babd9f4.json", "utf8"));
const tenant = JSON.parse(await readFile("config/tenants/northstar.json", "utf8"));
const access = new LocalAuthorization(JSON.parse(await readFile("config/catalog-access.json", "utf8")), "local-demo");
const ledger = new RunLedger("evidence/private/catalog-ledger");
const catalog = new CapabilityCatalog([artifact], tenant, async (capability, profile, inputs) => ledger.exclusively(async () => {
  const unfinished = (await ledger.inspect()).filter(run => run.state === "indeterminate");
  if (unfinished.length) throw new Error("Unfinished run requires reconciliation; no browser started.");
  const runId = `catalog-${randomUUID()}`;
  await ledger.start({ runId, tenant: profile.id, capability: capability.capability.id, version: capability.capability.version });
  const result = await replay({ runId, artifact: capability, tenant: profile, inputs,
    createSurface: (cap, config) => new WebSurface(cap, config),
    evidence: new FileEvidence("evidence/catalog", profile.id, runId) });
  await ledger.complete(runId, result.status);
  return result;
}), access);
console.log(JSON.stringify({ capabilities: catalog.list() }, null, 2));
try {
  const result = await catalog.invoke({ name: "member.read-savings-balance", version: "1.0.0", args: { memberId: "23456" } });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "success") process.exitCode = 1;
} catch {
  console.error("Catalog execution stopped. Inspect the private ledger and ownership lock; do not retry or clear an uncertain run automatically. Raw errors omitted.");
  process.exitCode = 1;
}
