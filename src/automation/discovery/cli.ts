import { readFile, mkdir, writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { tenantProfileSchema } from "../replay/policy.js";
import { WebSurface } from "../replay/web-surface.js";
import { FileEvidence } from "../replay/evidence.js";
import { OpenAIModel } from "./model.js";
import { discover } from "./engine.js";
import { replay } from "../replay/engine.js";
import { TerminalOperator } from "../replay/terminal-operator.js";
import { discoveryFailure } from "./errors.js";
import { trackedRun } from "../catalog/tracked-run.js";

try { loadEnvFile(); } catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new Error("Unable to load local environment configuration.");
}
if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) {
  console.error("Configure OPENAI_API_KEY and OPENAI_MODEL in your local .env file. Do not paste your key into chat.");
  process.exitCode = 2;
} else {
  const apiKey = process.env.OPENAI_API_KEY;
  const modelName = process.env.OPENAI_MODEL;
  try {
    const tenant = tenantProfileSchema.parse(JSON.parse(await readFile(process.env.TENANT_PROFILE ?? "config/tenants/northstar.json", "utf8")));
    if (tenant.appFamily !== "northstar-demo" || !["127.0.0.1", "localhost"].includes(new URL(tenant.origin).hostname)) throw new Error("Discovery currently permits only the synthetic local demo.");
    const runId = `discovery-${randomUUID()}`;
    await trackedRun({ runId, tenant: tenant.id, capability: "member.read-savings-balance", version: "1.0.0" }, async () => {
    const artifact = await discover({ runId, memberId: process.env.MEMBER_ID ?? "12345", tenant,
      ...(process.env.HUMAN_HANDOFF === "true" ? { intervention: new TerminalOperator() } : {}),
      verifyArtifact: async candidate => {
        const verificationId = `verification-${randomUUID()}`;
        const needsHuman = candidate.steps.some(step => step.humanCheckpoint);
        console.log(needsHuman
          ? "Live goal completed. Starting separate model-free verification in a NEW browser. Complete the operator check again there, then type resume."
          : "Live goal completed. Starting separate model-free verification.");
        const result = await replay({ runId: verificationId, artifact: candidate, inputs: { memberId: process.env.MEMBER_ID ?? "12345" }, tenant,
          ...(needsHuman && process.env.HUMAN_HANDOFF === "true" ? { intervention: new TerminalOperator(), timeoutMs: 300000 } : {}),
          evidence: new FileEvidence("evidence/runs", tenant.id, verificationId),
          createSurface: (capability, profile) => new WebSurface(capability, profile, !needsHuman) });
        if (result.status === "failure") console.error(`Verification failed: ${result.code}; run ${verificationId}`);
        return result.status === "success";
      },
      model: new OpenAIModel(apiKey, modelName, process.env.GOAL ?? "Find the member using memberId and read their current savings balance."),
      evidence: new FileEvidence("evidence/discovery", tenant.id, runId),
      createSurface: draft => new WebSurface(draft, tenant, process.env.HUMAN_HANDOFF !== "true" && process.env.HEADLESS !== "false") });
    const directory = resolve("evidence", "artifacts");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, `${runId}.json`);
    await writeFile(path, JSON.stringify(artifact, null, 2), { flag: "wx", mode: 0o600 });
    console.log(`Verified discovery artifact saved: ${path}`);
    console.log(`Replay with another synthetic member: ${artifact.steps.some(step => step.humanCheckpoint) ? "HUMAN_HANDOFF=true " : ""}TENANT_PROFILE=${process.env.TENANT_PROFILE ?? "config/tenants/northstar.json"} MEMBER_ID=23456 npm run replay -- ${path}`);
    }, () => "success");
  } catch (error) {
    const failure = discoveryFailure(error);
    console.error(`Discovery failure category: ${failure.code}`);
    console.error(failure.guidance);
    console.error("Discovery stopped without saving a capability. Raw errors omitted to protect secrets.");
    process.exitCode = 1;
  }
}
