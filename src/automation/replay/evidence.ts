import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EvidenceSink } from "./ports.js";
import { diagnosticSchema, manualActionSchema } from "./diagnostic-schema.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { failureCodeSchema } from "../contracts/results.js";
const eventSchema = z.object({ phase: z.enum(["intent", "completed", "result"]), stepIndex: z.number().int().nonnegative().nullable(),
  code: z.string().regex(/^[a-z_]+$/).max(100), manualAction: manualActionSchema.optional(),
  intervention: z.object({ reason: failureCodeSchema, stepId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/),
    diagnostic: z.string().regex(/^intervention-[0-9a-f-]{36}\.json$/) }).strict().optional() }).strict();
export class FileEvidence implements EvidenceSink {
  private readonly directory: string;
  constructor(root: string, tenantId: string, runId: string) {
    if (![tenantId, runId].every(value => /^[a-z0-9-]+$/.test(value))) throw new Error("Invalid evidence namespace");
    this.directory = resolve(root, tenantId, runId);
  }
  private async prepare(): Promise<void> { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
  async append(event: Parameters<EvidenceSink["append"]>[0]): Promise<void> {
    const safe = eventSchema.parse(event);
    await this.prepare();
    await appendFile(resolve(this.directory, "events.redacted.jsonl"), JSON.stringify({ timestamp: new Date().toISOString(), ...safe }) + "\n", { mode: 0o600 });
  }
  async diagnostic(value: Parameters<EvidenceSink["diagnostic"]>[0], purpose?: "intervention"): Promise<string> {
    const safe = diagnosticSchema.parse(value);
    await this.prepare();
    const filename = purpose === "intervention" ? `intervention-${randomUUID()}.json` : "diagnostic.json";
    await writeFile(resolve(this.directory, filename), JSON.stringify(safe, null, 2), { mode: 0o600, flag: purpose === "intervention" ? "wx" : "w" });
    return filename;
  }
}
