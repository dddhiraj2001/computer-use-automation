import { readFile } from "node:fs/promises";
import { capabilitySchema } from "./capability.js";

const filename = process.argv[2] ?? "examples/member-balance.capability.json";
try {
  const artifact = capabilitySchema.parse(JSON.parse(await readFile(filename, "utf8")) as unknown);
  console.log(`Valid capability: ${artifact.capability.id} v${artifact.capability.version}`);
  console.log(`${artifact.steps.length} steps; inputs: ${Object.keys(artifact.inputs).join(", ")}; outputs: ${Object.keys(artifact.outputs).join(", ")}`);
  console.log(`Source: ${artifact.metadata.source}. Schema validation does not prove replay success or policy approval.`);
} catch {
  // Do not echo untrusted input, file contents, or validator messages containing values.
  console.error("Capability validation failed. Check the file against the documented v1 contract.");
  process.exitCode = 1;
}
