import { z } from "zod";

const identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const description = z.string().min(1).max(2000);
export const riskSchema = z.enum(["read_only", "reversible", "irreversible"]);
export const actionKindSchema = z.enum(["navigate", "click", "type", "wait"]);
export const recoveryCodeSchema = z.enum(["transient_timeout", "temporarily_unavailable"]);

// No arbitrary regex/code evaluation in v1. Formats have fixed validation rules.
export const fieldSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), description, sensitive: z.boolean(),
    format: z.enum(["text", "member_id", "decimal_money", "currency"]),
    maxLength: z.number().int().min(1).max(10000) }).strict(),
  z.object({ type: z.literal("integer"), description, sensitive: z.boolean(),
    minimum: z.number().int().safe(), maximum: z.number().int().safe() }).strict(),
  z.object({ type: z.literal("boolean"), description, sensitive: z.boolean() }).strict()
]);

// Targets are references, not live browser handles. Strategies are ordered.
const locatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("role"), role: description, name: description, exact: z.literal(true) }).strict(),
  z.object({ kind: z.literal("label"), text: description, exact: z.literal(true) }).strict(),
  z.object({ kind: z.literal("text"), text: description, exact: z.literal(true) }).strict(),
  z.object({ kind: z.literal("css"), selector: description }).strict()
]);
export const targetSchema = z.object({
  description,
  robustness: description,
  framePath: z.array(z.string().min(1).max(500)).max(8),
  strategies: z.array(locatorSchema).min(1).max(5)
}).strict();

export const conditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("visible"), target: identifier }).strict(),
  z.object({ kind: z.literal("text_equals"), target: identifier, value: description }).strict(),
  z.object({ kind: z.literal("text_contains_input"), target: identifier, input: identifier }).strict()
]);

const stepBase = {
  humanCheckpoint: z.object({ reason: z.literal("operator_required"),
    instructions: z.literal("Resolve the operator-only state, then resume; the step postconditions must pass.") }).strict().optional(),
  id: identifier,
  description,
  risk: riskSchema,
  timeoutMs: z.number().int().min(100).max(60000),
  preconditions: z.array(conditionSchema).max(20),
  postconditions: z.array(conditionSchema).min(1).max(20),
  retry: z.object({
    maxAttempts: z.number().int().min(1).max(3),
    on: z.array(recoveryCodeSchema).max(2),
    repeatSafe: z.boolean()
  }).strict()
};

const stepSchema = z.discriminatedUnion("action", [
  z.object({ ...stepBase, action: z.literal("navigate"), path: z.string().regex(/^\/(?!\/)[^?#\\]*$/) }).strict(),
  z.object({ ...stepBase, action: z.literal("click"), target: identifier }).strict(),
  z.object({ ...stepBase, action: z.literal("type"), target: identifier, input: identifier }).strict(),
  z.object({ ...stepBase, action: z.literal("wait"), until: conditionSchema }).strict()
]);

const fields = z.record(identifier, fieldSchema);
export const capabilitySchema = z.object({
  schemaVersion: z.enum(["1.0", "1.1"]),
  capability: z.object({ id: identifier, version, description, status: z.literal("draft") }).strict(),
  compatibility: z.object({
    appFamily: identifier,
    appVersions: z.array(version).min(1),
    surface: z.literal("web"),
    requiredFeatures: z.array(z.enum(["structured_targets", "frames", "manual_control"])).min(1)
  }).strict(),
  inputs: fields,
  outputs: fields,
  targets: z.record(identifier, targetSchema),
  policy: z.object({
    // These are requested permissions. Trusted execution config must intersect them.
    allowedRoutes: z.array(z.string().regex(/^\/(?!\/)[^?#\\]*$/)).min(1),
    allowedActions: z.array(actionKindSchema).min(1),
    maximumRisk: riskSchema
  }).strict(),
  steps: z.array(stepSchema).min(1).max(100),
  outcomes: z.array(z.object({
    code: identifier, description,
    when: z.array(conditionSchema).min(1),
    afterSteps: z.array(identifier).min(1)
  }).strict()).max(20),
  checkpoint: z.array(conditionSchema).min(1),
  extract: z.array(z.object({ output: identifier, target: identifier,
    transform: z.enum(["text", "usd_money_to_decimal"]) }).strict()),
  metadata: z.object({
    source: z.enum(["hand_authored", "llm_discovery"]),
    createdAt: z.string().datetime(),
    discoveryRunId: identifier.optional()
  }).strict()
}).strict().superRefine((artifact, context) => {
  const issue = (path: (string | number)[], message: string) =>
    context.addIssue({ code: z.ZodIssueCode.custom, path, message });
  const has = (record: object, name: string) => Object.hasOwn(record, name);
  const checkTarget = (name: string, path: (string | number)[]) => {
    if (!has(artifact.targets, name)) issue(path, "Unknown target reference");
  };
  const checkCondition = (condition: z.infer<typeof conditionSchema>, path: (string | number)[]) => {
    checkTarget(condition.target, [...path, "target"]);
    if (condition.kind === "text_contains_input" && !has(artifact.inputs, condition.input)) {
      issue([...path, "input"], "Unknown input reference");
    }
  };
  const ranks = { read_only: 0, reversible: 1, irreversible: 2 };
  const ids = new Set<string>();
  artifact.steps.forEach((step, index) => {
    const path = ["steps", index];
    if (ids.has(step.id)) issue([...path, "id"], "Duplicate step ID");
    ids.add(step.id);
    if (step.humanCheckpoint && (artifact.schemaVersion !== "1.1" || !artifact.compatibility.requiredFeatures.includes("manual_control"))) {
      issue(path, "Human checkpoints require schema 1.1 and manual_control");
    }
    if (!artifact.policy.allowedActions.includes(step.action)) issue(path, "Action excluded by artifact policy");
    if (ranks[step.risk] > ranks[artifact.policy.maximumRisk]) issue(path, "Risk exceeds artifact policy");
    if (step.retry.maxAttempts > 1 && (!step.retry.repeatSafe || step.risk === "irreversible" || step.retry.on.length === 0)) {
      issue([...path, "retry"], "Retries require an explicitly repeat-safe action and recoverable codes; irreversible actions cannot retry");
    }
    if ("target" in step) checkTarget(step.target, [...path, "target"]);
    if (step.action === "type" && artifact.inputs[step.input]?.type !== "string") {
      issue([...path, "input"], "Typing requires a declared string input");
    }
    if (step.action === "navigate" && !artifact.policy.allowedRoutes.includes(step.path)) issue(path, "Navigation route excluded by artifact policy");
    if (step.action === "wait") checkCondition(step.until, [...path, "until"]);
    step.preconditions.forEach((condition, i) => checkCondition(condition, [...path, "preconditions", i]));
    step.postconditions.forEach((condition, i) => checkCondition(condition, [...path, "postconditions", i]));
  });
  const outcomeCodes = new Set<string>();
  artifact.outcomes.forEach((outcome, i) => {
    if (outcomeCodes.has(outcome.code)) issue(["outcomes", i, "code"], "Duplicate outcome code");
    outcomeCodes.add(outcome.code);
    outcome.afterSteps.forEach((id, j) => { if (!ids.has(id)) issue(["outcomes", i, "afterSteps", j], "Unknown step reference"); });
    outcome.when.forEach((condition, j) => checkCondition(condition, ["outcomes", i, "when", j]));
  });
  artifact.checkpoint.forEach((condition, i) => checkCondition(condition, ["checkpoint", i]));
  const extracted = new Set<string>();
  artifact.extract.forEach((extraction, i) => {
    const field = artifact.outputs[extraction.output];
    if (!field) issue(["extract", i, "output"], "Unknown output reference");
    if (field?.type !== "string") issue(["extract", i], "V1 extraction supports string outputs only");
    if (extraction.transform === "usd_money_to_decimal" && (field?.type !== "string" || field.format !== "decimal_money")) {
      issue(["extract", i], "Money transform requires decimal_money output");
    }
    if (extracted.has(extraction.output)) issue(["extract", i], "Duplicate output extraction");
    extracted.add(extraction.output);
    checkTarget(extraction.target, ["extract", i, "target"]);
  });
  Object.keys(artifact.outputs).forEach((name) => {
    if (!extracted.has(name)) issue(["outputs", name], "Output requires an extraction rule");
  });
  for (const category of ["inputs", "outputs"] as const) {
    Object.entries(artifact[category]).forEach(([name, field]) => {
      if (["__proto__", "constructor", "prototype"].includes(name)) issue([category, name], "Reserved field name");
      if (field.type === "integer" && field.minimum > field.maximum) issue([category, name], "Invalid numeric range");
    });
  }
  if (artifact.metadata.source === "llm_discovery" && !artifact.metadata.discoveryRunId) {
    issue(["metadata", "discoveryRunId"], "LLM-discovered artifacts require a discovery run reference");
  }
});

export type Capability = z.infer<typeof capabilitySchema>;
export type Field = z.infer<typeof fieldSchema>;

/** Values are never coerced: a numeric member ID must not lose leading zeroes. */
export function validateValues(fields: Record<string, Field>, values: unknown): Record<string, string | number | boolean> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, field] of Object.entries(fields)) {
    if (["__proto__", "constructor", "prototype"].includes(name)) throw new Error("Reserved field name");
    if (field.type === "boolean") shape[name] = z.boolean();
    else if (field.type === "integer") shape[name] = z.number().int().safe().min(field.minimum).max(field.maximum);
    else {
      let schema = z.string().min(1).max(field.maxLength);
      if (field.format === "member_id") schema = schema.regex(/^[0-9]{5}$/);
      if (field.format === "decimal_money") schema = schema.regex(/^-?(?:0|[1-9][0-9]*)\.[0-9]{2}$/);
      if (field.format === "currency") schema = schema.regex(/^[A-Z]{3}$/);
      shape[name] = schema;
    }
  }
  return z.object(shape).strict().parse(values) as Record<string, string | number | boolean>;
}
