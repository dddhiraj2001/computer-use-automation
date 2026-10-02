import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { capabilitySchema, validateValues } from "./capability.js";
import { eventSchema, interventionSchema, replayResultSchema, validateReplayResult } from "./results.js";

const fixture = JSON.parse(readFileSync(new URL("../../../examples/member-balance.capability.json", import.meta.url), "utf8"));
const parsed = () => capabilitySchema.parse(structuredClone(fixture));

test("example is serializable, versioned, and explicitly hand-authored", () => {
  const artifact = parsed();
  assert.deepEqual(capabilitySchema.parse(JSON.parse(JSON.stringify(artifact))), artifact);
  assert.equal(artifact.metadata.source, "hand_authored");
});

const invalidCases: [string, (artifact: any) => void][] = [
  ["unsupported schema version", a => { a.schemaVersion = "2.0"; }],
  ["transcript field", a => { a.transcript = "not a workflow"; }],
  ["duplicate step IDs", a => { a.steps[1].id = a.steps[0].id; }],
  ["missing target", a => { a.steps[1].target = "unknown"; }],
  ["undeclared input", a => { a.steps[1].input = "unknown"; }],
  ["missing checkpoint", a => { a.checkpoint = []; }],
  ["unextracted output", a => { a.extract = []; }],
  ["unknown extraction target", a => { a.extract[0].target = "unknown"; }],
  ["unknown outcome step", a => { a.outcomes[0].afterSteps = ["unknown"]; }],
  ["duplicate outcome code", a => { a.outcomes.push(a.outcomes[0]); }],
  ["unsafe retries", a => { a.steps[2].retry.maxAttempts = 3; }],
  ["irreversible retries", a => { a.policy.maximumRisk = "irreversible"; a.steps[2].risk = "irreversible"; a.steps[2].retry = { maxAttempts: 2, on: ["transient_timeout"], repeatSafe: true }; }],
  ["action outside artifact policy", a => { a.policy.allowedActions = ["navigate"]; }],
  ["absolute navigation URL", a => { a.steps[0].path = "https://example.com"; }],
  ["false discovery provenance", a => { a.metadata.source = "llm_discovery"; }]
];
for (const [name, mutate] of invalidCases) {
  test(`rejects ${name}`, () => {
    const artifact = structuredClone(fixture);
    mutate(artifact);
    assert.equal(capabilitySchema.safeParse(artifact).success, false);
  });
}

test("input validation preserves leading zeroes and rejects coercion/extra fields", () => {
  const { inputs } = parsed();
  assert.deepEqual(validateValues(inputs, { memberId: "01234" }), { memberId: "01234" });
  for (const invalid of [{}, { memberId: 12345 }, { memberId: "abcde" }, { memberId: "12345", token: "unexpected" }]) {
    assert.throws(() => validateValues(inputs, invalid));
  }
});

const identity = { runId: "run-1", capabilityId: "member.read-savings-balance", capabilityVersion: "1.0.0" };
test("success must verify checkpoint and satisfy declared outputs", () => {
  const success = { ...identity, status: "success", checkpointVerified: true, outputs: { balance: "8240.75" } };
  assert.equal(validateReplayResult(parsed(), success).status, "success");
  assert.throws(() => validateReplayResult(parsed(), { ...success, checkpointVerified: false }));
  assert.throws(() => validateReplayResult(parsed(), { ...success, outputs: { balance: 8240.75 } }));
  assert.throws(() => validateReplayResult(parsed(), { ...success, outputs: { balance: "$8,240.75" } }));
  assert.throws(() => validateReplayResult(parsed(), { ...success, outputs: {} }));
});
test("known business outcomes are distinct from failures and must be declared", () => {
  assert.equal(validateReplayResult(parsed(), { ...identity, status: "business_outcome", code: "member_not_found" }).status, "business_outcome");
  assert.throws(() => validateReplayResult(parsed(), { ...identity, status: "business_outcome", code: "unknown" }));
  assert.equal(replayResultSchema.safeParse({ ...identity, status: "recoverable" }).success, false);
});
test("failure identifies a consistent artifact step and preserves recovery history", () => {
  const failure = { ...identity, status: "failure", code: "recovery_exhausted", stepId: "search-member", stepIndex: 2,
    expected: "Unique result link", observedRedacted: "Loading did not finish", evidence: [], interventionAvailable: true,
    retries: [{ attempt: 1, code: "transient_timeout" }] };
  assert.equal(validateReplayResult(parsed(), failure).status, "failure");
  assert.throws(() => validateReplayResult(parsed(), { ...failure, stepIndex: 0 }));
  assert.throws(() => validateReplayResult(parsed(), { ...failure, stepId: null }));
  assert.throws(() => validateReplayResult(parsed(), { ...failure, capabilityVersion: "9.0.0" }));
});
test("audit events and interventions require structured context", () => {
  const event = { timestamp: "2026-09-28T00:00:00Z", runId: "run-1", actor: "human", phase: "handoff", kind: "control_transfer",
    stepId: "search-member", summaryRedacted: "Operator returned control", reasonRedacted: "Session restored", evidence: [] };
  assert.equal(eventSchema.safeParse(event).success, true);
  assert.equal(eventSchema.safeParse({ ...event, rawScreenshot: "not permitted" }).success, false);
  const intervention = { id: "help-1", runId: "run-1", sessionId: "session-1", goalRedacted: "Read member balance",
    capabilityId: identity.capabilityId, stepId: "search-member", reason: "stuck", stateRedacted: "Session expired",
    evidence: [], owner: "none", state: "requested", createdAt: event.timestamp };
  assert.equal(interventionSchema.safeParse(intervention).success, true);
  assert.equal(interventionSchema.safeParse({ ...intervention, sessionId: undefined }).success, false);
});
