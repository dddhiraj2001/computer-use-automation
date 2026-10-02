import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { RunLedger } from "./run-ledger.js";
import { LocalAuthorization } from "./authorization.js";

// Local operator entrypoint. No caller identity can be supplied by an agent payload.
const scope = process.argv[2] ?? "catalog";
if (!["catalog", "execution"].includes(scope)) throw new Error("Use catalog or execution scope.");
const ledger = new RunLedger(`evidence/private/${scope}-ledger`);
const authorization = new LocalAuthorization(JSON.parse(await readFile("config/catalog-access.json", "utf8")), "local-operator");
if (!process.stdin.isTTY) throw new Error("Interactive operator review required.");
const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
  const owner = await ledger.owner();
  console.log(JSON.stringify({ ownerPid: owner.pid, runs: await ledger.inspect() }, null, 2));
  console.log("Review the application and evidence first. Confirm any effects externally and close the abandoned demo browser. This abandons interrupted runs, never marks them successful or repeats them.");
  const answer = await terminal.question("Type ABANDON AFTER REVIEW to confirm, or anything else to cancel: ");
  await ledger.abandonInterrupted(owner.token, authorization, answer === "ABANDON AFTER REVIEW");
  console.log("Interrupted work recorded as abandoned. No action was replayed.");
} catch {
  console.error("Recovery refused or incomplete. Owner may be live, authorization missing, or evidence inconsistent. Retain the ledger and investigate; do not delete locks blindly.");
  process.exitCode = 1;
} finally { terminal.close(); }
