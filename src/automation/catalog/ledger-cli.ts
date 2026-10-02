import { RunLedger } from "./run-ledger.js";
for (const scope of ["catalog", "execution"]) console.log(JSON.stringify({ scope,
  runs: await new RunLedger(`evidence/private/${scope}-ledger`).inspect() }, null, 2));
