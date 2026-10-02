# Capability contract: schema 1.0 and 1.1

`capability.ts` is the executable schema and inferred TypeScript contract. `results.ts` validates replay results; its broader event/intervention schemas are reference contracts, not the persisted JSONL format. Runtime evidence is validated by replay/evidence.ts and replay/diagnostic-schema.ts. `outputs.ts` provides shared discovery/replay transforms and output validation.

## Scope and trust boundary

Contracts, model discovery, deterministic replay and local human control are implemented through injected SurfaceAdapter, EvidenceSink and operator ports. The example in examples/ is hand-authored, not discovery evidence. Historical genuine discovery and replay evidence is indexed under evidence/. Current diagnostics are bounded text-free structural snapshots, not screenshots.

An artifact is untrusted input. The executor intersects its permissions with trusted tenant policy. Click/type targets must match complete reviewed locator/frame definitions and permitted actions; artifact risk cannot fall below the trusted minimum. Unknown controls and irreversible effective risk are denied. Discovery copies reviewed static descriptors, including identity locators, instead of observed prose. Strict schemas cannot detect PII in arbitrary hand-imported artifacts: review imports before persistence. No secrets, concrete inputs, cookies or model transcripts belong in artifacts. Caller outputs may be sensitive and are not automatically evidence.

## Current execution semantics

1. Parse schema 1.0 or 1.1; reject unsupported versions. Schema 1.1 permits step humanCheckpoint, requires manual_control and an operator, and fails before startup without one; schema 1.0 rejects that field.
2. Validate invocation inputs without coercion and verify app/version/adapter compatibility.
3. Resolve target strategies in their declared order. Zero matches permits the next strategy; multiple matches stop with `target_ambiguous`. Never choose the first ambiguous match.
4. Before every action, enforce trusted policy, control ownership, and step preconditions.
5. After each action, inspect declared business outcomes for that step before requiring the success-path postconditions. For example, `member_not_found` after search terminates normally instead of waiting for an account link that will never appear. Multiple conflicting outcomes must stop as an unexpected state.
6. Only declared observation waits can automatically retry, within bounded attempts. repeatSafe never authorizes uncertain click/write retries. Exact trusted informational alerts may be dismissed once; unknown confirmations stop. Eligible step failures use same-session handoff; resume verifies outcomes/postconditions without repeating the action.
7. At completion, verify the complete checkpoint, extract/transform all outputs, recheck the checkpoint and validate declared output fields. Eligible final-stage failures allow at most one handoff within the original deadline. Discard partial outputs and restart all checks/reads, never earlier actions. Repeated failures, abort or identity mismatch stop.
8. Discovery uses the same money transform and declared output validation before emitting a verified artifact. Assisted candidates additionally pass independent model-free replay; declared human checkpoints may need an operator in that separate verification session.

All condition arrays mean AND. Attempts include the initial attempt. Failure step indexes are zero-based; both step fields are null for failures before any step starts. Business outcomes are terminal results; recovery is an internal event that ends in one of success, business outcome, or failure. The `checkpointVerified` field records the executor's assertion and is not independent proof that a UI was checked.

`usd_money_to_decimal` accepts an optional dollar sign, ungrouped digits or correctly grouped thousands, and exactly two decimals. It trims outer whitespace and normalizes with BigInt, not floating-point arithmetic: `$8,240.75` becomes `8240.75`; `$1,2.00` is rejected. Declared output length/format limits also apply. Routes are root-relative; :memberId matches one validated path segment, not arbitrary paths. The origin comes from trusted configuration.

Each intervention persists its reason, step identity and unique sanitized diagnostic before control transfer. Final-stage intervention context names final-output; a terminal final-stage failure retains the last workflow step index and identifies output stage in expected. Policy/audit/hard failures cannot be overridden by an operator.

## Surface and tenant boundary

The outer flow uses target references and typed actions, not browser handles or executable scripts. V1 supports only web targets. CSS is explicitly a browser strategy; the example uses one Playwright CSS extension for a table anchor. Accessibility/visual/desktop strategies need a versioned schema extension and an adapter that advertises support. Unsupported strategies must fail compatibility checks, not fall back to unverified coordinates.

`framePath` lists outer-to-inner frame selectors; empty means main page. HTTP faults and configured error/operator markers in attached frames participate in session health checks. Expiry recovery requires HTTP 200 and the configured marker in every affected original frame; a healthy parent cannot clear an expired child, and detached affected frames are refused. Discovery observations and structural diagnostics currently cover the top document, not frame/shadow contents.

Tenant profiles implement origin/routes, reviewed controls and known-target overrides without changing action/input/output contracts. Overrides must satisfy independent control policy. Optional live-version markers reject missing/ambiguous/changed versions; otherwise compatibility relies on trusted configuration. Native desktop/visual strategies still need a versioned schema and adapter extension. Local tenant isolation is not hosted identity authentication.

## Validate

```sh
npm run capability:validate
npm run capability:validate -- path/to/capability.json
npm test
MEMBER_ID=12345 npm run replay
```

The validator prints only a capability summary on success and a generic error on failure; it does not echo input values. Internal Zod errors must not be persisted without redaction.
