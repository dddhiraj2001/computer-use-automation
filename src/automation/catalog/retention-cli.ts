import { RunLedger } from "./run-ledger.js";
const scope = process.argv[2] ?? "catalog";
if (!["catalog", "execution"].includes(scope)) throw new Error("Use catalog or execution scope.");
const apply = process.argv[3] === "--apply";
const runs = await new RunLedger(`evidence/private/${scope}-ledger`).archiveCompleted(30, apply,
  scope === "catalog" ? ["evidence/catalog"] : ["evidence/runs", "evidence/discovery"]);
console.log(JSON.stringify({ scope, mode: apply ? "archived_recoverably" : "dry_run", retentionDays: 30, runs,
  preserved: "Unresolved/abandoned runs, untracked historical evidence, release receipts and capability artifacts remain untouched. Eligible runtime logs move with their completed journal." }, null, 2));
