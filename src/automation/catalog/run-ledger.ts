import { mkdir, open, readFile, readdir, unlink, lstat, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { LocalAuthorization } from "./authorization.js";

const id = z.string().regex(/^[a-zA-Z0-9_.-]{1,120}$/).refine(value => value !== "." && value !== "..");
const startedSchema = z.object({ runId: id, tenant: id, capability: id,
  version: z.string().regex(/^\d+\.\d+\.\d+$/), startedAt: z.string().datetime() }).strict();
const completedSchema = z.object({ status: z.enum(["success", "business_outcome", "failure"]), completedAt: z.string().datetime() }).strict();
const ownerSchema = z.object({ token: z.string().uuid(), pid: z.number().int().positive() }).strict();
const reviewSchema = z.object({ decision: z.literal("abandoned_no_retry"), reviewedAt: z.string().datetime(), ownerToken: z.string().uuid() }).strict();

/** Value-free local journal. Unfinished does not imply safe to retry or prove the owner died. */
export class RunLedger {
  constructor(private readonly root: string) {}
  /** Recoverable archive, never deletion. Indeterminate and reviewed/abandoned work stays on hold. */
  async archiveCompleted(days: number, apply = false, evidenceRoots: readonly string[] = []): Promise<string[]> {
    if (!Number.isInteger(days) || days < 30) throw new Error("Retention must be at least 30 days.");
    return this.exclusively(async () => {
      const eligible: string[] = [];
      for (const run of await this.inspect()) {
        if (run.state !== "completed") continue;
        const paths = ["started", "completed"].map(kind => join(this.root, `${run.runId}.${kind}.json`));
        if (!(await Promise.all(paths.map(path => lstat(path)))).every(stat => stat.isFile() && !stat.isSymbolicLink())) continue;
        const completion = completedSchema.parse(JSON.parse(await readFile(paths[1]!, "utf8")));
        const started = startedSchema.parse(JSON.parse(await readFile(paths[0]!, "utf8")));
        if (Date.parse(completion.completedAt) >= Date.now() - days * 86400000) continue;
        eligible.push(run.runId);
        if (apply) {
          const destination = join(this.root, "archive", run.runId);
          await mkdir(join(this.root, "archive"), { recursive: true, mode: 0o700 });
          await mkdir(destination, { mode: 0o700 }); // Refuse overwrite of any previous archive.
          // Completion first: interruption conservatively leaves the source run indeterminate.
          await rename(paths[1]!, join(destination, "completed.json"));
          await rename(paths[0]!, join(destination, "started.json"));
          for (const [index, root] of evidenceRoots.entries()) {
            const source = join(root, started.tenant, run.runId);
            try {
              const tenantDirectory = await lstat(join(root, started.tenant));
              const runDirectory = await lstat(source);
              if (tenantDirectory.isSymbolicLink() || !tenantDirectory.isDirectory() || runDirectory.isSymbolicLink() || !runDirectory.isDirectory()) continue;
              await rename(source, join(destination, `evidence-${index}`));
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            }
          }
        }
      }
      return eligible;
    });
  }
  async owner(): Promise<z.infer<typeof ownerSchema>> {
    return ownerSchema.parse(JSON.parse(await readFile(join(this.root, "owner.lock"), "utf8")));
  }
  /** Trusted local operator abandons work after external reconciliation; never marks it successful. */
  async abandonInterrupted(expectedToken: string, authorization: LocalAuthorization, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error("Explicit reconciliation confirmation required.");
    const owner = await this.owner();
    if (owner.token !== expectedToken) throw new Error("Ownership changed; review again.");
    let absent = false;
    try { process.kill(owner.pid, 0); }
    catch (error) { absent = error instanceof Error && "code" in error && error.code === "ESRCH"; }
    if (!absent) throw new Error("Owner is live or its status is uncertain; cannot reconcile.");
    const pending = (await this.inspect()).filter(run => run.state === "indeterminate");
    const records = await Promise.all(pending.map(async run => startedSchema.parse(JSON.parse(await readFile(join(this.root, `${run.runId}.started.json`), "utf8")))));
    if (!records.length) throw new Error("No unresolved run to reconcile; manual storage review required.");
    if (records.some(record => !authorization.permits(record.tenant, "operations.reconcile", "1.0.0"))) throw new Error("Reconciliation not authorized.");
    // A second reviewer cannot enter; a crashed review deliberately leaves this lock for investigation.
    const recoveryPath = join(this.root, "recovery.lock");
    await this.persist(recoveryPath, { ownerToken: owner.token });
    try {
      if ((await this.owner()).token !== expectedToken) throw new Error("Ownership changed; review again.");
      for (const record of records) await this.persist(join(this.root, `${record.runId}.reviewed.json`),
        reviewSchema.parse({ decision: "abandoned_no_retry", reviewedAt: new Date().toISOString(), ownerToken: expectedToken }));
      await unlink(join(this.root, "owner.lock"));
      const directory = await open(this.root, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(recoveryPath); }
  }
  /** Exclusive local filesystem admission. Never expires or steals a possibly-live owner's lock. */
  async exclusively<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, "owner.lock");
    const token = randomUUID();
    try { await this.persist(path, { token, pid: process.pid }); }
    catch { throw new Error("Run ownership unavailable; another process may be active or interrupted. Review before recovery."); }
    try {
      if ((await readdir(this.root)).includes("recovery.lock")) throw new Error("Recovery review is incomplete.");
      return await work();
    }
    finally {
      // If the lock is corrupted/replaced, retain it and fail closed. Never delete another owner's lock.
      const owner: unknown = JSON.parse(await readFile(path, "utf8"));
      const parsed = z.object({ token: z.string().uuid(), pid: z.number().int().positive() }).strict().parse(owner);
      if (parsed.token !== token) throw new Error("Run ownership changed; reconciliation required.");
      await unlink(path);
      const directory = await open(this.root, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  private async persist(path: string, data: unknown): Promise<void> {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(data)); await file.sync(); }
    finally { await file.close(); }
    const directory = await open(this.root, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async start(record: Omit<z.infer<typeof startedSchema>, "startedAt">): Promise<void> {
    const safe = startedSchema.parse({ ...record, startedAt: new Date().toISOString() });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.persist(join(this.root, `${safe.runId}.started.json`), safe);
  }
  async complete(runId: string, status: z.infer<typeof completedSchema>["status"]): Promise<void> {
    id.parse(runId);
    startedSchema.parse(JSON.parse(await readFile(join(this.root, `${runId}.started.json`), "utf8")));
    await this.persist(join(this.root, `${runId}.completed.json`), completedSchema.parse({ status, completedAt: new Date().toISOString() }));
  }
  async inspect(): Promise<Array<{ runId: string; state: "completed" | "indeterminate" | "abandoned" }>> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root);
    const results: Array<{ runId: string; state: "completed" | "indeterminate" | "abandoned" }> = [];
    for (const name of entries.filter(name => name.endsWith(".started.json"))) {
      const runId = id.parse(name.slice(0, -".started.json".length));
      let state: "completed" | "indeterminate" | "abandoned" = "indeterminate";
      try {
        const started = startedSchema.parse(JSON.parse(await readFile(join(this.root, name), "utf8")));
        if (started.runId !== runId) throw new Error("Ledger identity mismatch");
        completedSchema.parse(JSON.parse(await readFile(join(this.root, `${runId}.completed.json`), "utf8")));
        state = "completed";
      } catch { /* Missing/torn/invalid records require review; never infer completion. */ }
      if (state === "indeterminate") {
        try {
          reviewSchema.parse(JSON.parse(await readFile(join(this.root, `${runId}.reviewed.json`), "utf8")));
          state = "abandoned";
        } catch { /* No validated operator review; keep blocked. */ }
      }
      results.push({ runId, state });
    }
    return results;
  }
}
