import { validateValues, type Capability } from "./capability.js";

/** One display parser for discovery and replay; never use floating-point money. */
export function transformOutput(text: string, transform: Capability["extract"][number]["transform"]): string {
  const value = text.trim();
  if (transform !== "usd_money_to_decimal") return value;
  const match = /^\$?((?:\d{1,3}(?:,\d{3})+|\d+))\.(\d{2})$/.exec(value);
  if (!match) throw new Error("Unsupported output format");
  return `${BigInt(match[1]!.replaceAll(",", ""))}.${match[2]}`;
}

export function validateOutputs(capability: Capability, outputs: unknown) {
  return validateValues(capability.outputs, outputs);
}
