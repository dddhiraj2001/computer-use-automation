import { RunLedger } from "./run-ledger.js";

export const executionLedger = new RunLedger("evidence/private/execution-ledger");
/** Operator CLIs share one local admission/journal boundary. Nested verification belongs to discovery. */
export async function trackedRun<T>(record: { runId: string; tenant: string; capability: string; version: string },
  work: () => Promise<T>, status: (value: T) => "success" | "failure" | "business_outcome", ledger = executionLedger): Promise<T> {
  return ledger.exclusively(async () => {
    if ((await ledger.inspect()).some(run => run.state === "indeterminate")) throw new Error("Reconciliation required.");
    await ledger.start(record);
    let result: T;
    try { result = await work(); }
    catch (error) { await ledger.complete(record.runId, "failure"); throw error; }
    await ledger.complete(record.runId, status(result));
    return result;
  });
}
