# Architecture

The project automates one real browser workflow: search for a synthetic member, open the account, and read the savings balance. I chose a local server-rendered app so error states can be reproduced without real credentials or customer data.

Discovery uses an LLM to observe controls and choose the next action. The runner validates the decision and applies policy before acting. Successful discovery saves a JSON capability, not a model transcript. Replay reads that capability and never calls the model.

TypeScript provides shared types; Zod validates data entering the system. Playwright handles the browser behind SurfaceAdapter. The engines depend on small interfaces for the surface, evidence and operator, rather than on browser or filesystem details. CLI commands connect the parts. This keeps the system local and easy to run.

I chose OpenAI's Responses API for schema-constrained decisions. The example configuration selects `gpt-4.1-mini-2025-04-14`: a small, dated model is a practical starting point for this narrow task, without claiming it outperforms alternatives. `OPENAI_MODEL` is configurable, and ModelAdapter isolates the provider. Each request includes the goal and current controls; the prompt treats page content as untrusted and requests one action, an input reference and an enumerated reason. The response schema limits target IDs to the current observation. Runtime validation and policy still check every proposal; structured output alone cannot make an action safe. Discovery has step/time limits, while replay needs no model access.

# Artifact schema

The artifact separates schema version, capability version and compatible app versions. It declares typed inputs/outputs, named targets, ordered steps, preconditions, postconditions, business outcomes and a final checkpoint. A type action refers to an input name such as memberId, not the recorded value.

Targets use exact roles/labels or table-heading anchors, with ordered fallback strategies. Each target explains its purpose and robustness. Discovery copies only reviewed static target descriptions from trusted configuration; it does not save arbitrary page text.

Schema 1.0 supports ordinary flows. Schema 1.1 adds explicit human checkpoints and requires manual-control support. Unknown versions, missing references and inconsistent outputs are rejected. Input/output definitions and known business outcomes are domain configuration; the model learns the sequence, not those definitions.

# Determinism & error handling

Replay follows recorded steps without model decisions. It refuses ambiguous targets and waits for conditions instead of sleeping for a guessed duration. Final success requires the correct member, the checkpoint and valid outputs. Discovery and replay share the same money parser; monetary values remain decimal strings, not floating-point numbers.

Results distinguish success, expected business outcomes such as member_not_found, and failures such as permission_denied. Main-document and nested-frame HTTP errors are checked, as are configured UI error markers. Tests cover validation rejection, expiry, server errors, slowness, dialogs and version changes.

Only safe observation waits can retry automatically. Unknown confirmations stop; one explicitly approved informational alert may be dismissed. Uncertain clicks are never repeated. Errors name the failed stage/step and link to a sanitized structural diagnostic.

# Heterogeneity & multi-tenant

The flow refers to targets rather than browser handles. A tenant profile supplies the origin, allowed routes/actions, reviewed controls, app version and known-target overrides. The same recorded artifact runs on Northstar and the differently branded Cedar variant; the source hash stays unchanged.

Overrides cannot add workflow actions or grant permissions. Optional live-version markers stop execution when a version is missing, ambiguous or different. Without a marker, compatibility relies on trusted configuration. A new vendor version needs profile review and regression testing, not automatic selector guessing.

Replay supports nested frames and table anchors for legacy web pages. The current schema is still web-specific, including some Playwright CSS syntax. Desktop support would need a versioned target type for accessibility identities or anchored visual regions, a new adapter and OS-level control ownership. Screenshot-only targeting and desktop automation are design extensions, not implemented features.

# Escalation & handoff

Discovery stops, repeated decisions and eligible execution failures can request help in the terminal. Automation pauses and gives the operator the same live browser. Browser actions are rejected while the human owns it. Before transfer, evidence records the reason, step and a unique text-free diagnostic.

The operator completes the manual work and types resume or abort. Resume checks the blocked step's result rather than repeating it. Session recovery also needs HTTP 200 and the configured access marker in every affected original frame. A healthy parent cannot clear an expired child.

Final-checkpoint or output-read failures can request one additional bounded intervention. Partial outputs are discarded, then all final checks and reads restart; earlier actions do not. Assisted discovery candidates must pass separate model-free replay before saving. If the artifact declares a human checkpoint, that separate verification may need a person too.

# Safety

Trusted policy restricts destinations, routes, request methods and control/action pairs. The effective risk cannot be lower than the trusted control minimum, regardless of the artifact's label. Unknown controls and irreversible actions are blocked. Redirects, WebSockets and extra windows are also blocked.

Evidence uses allowlisted metadata, not raw page content, credentials, input values or model responses. Structural diagnostics retain hierarchy and geometry but omit text and attributes. They do not capture frame/shadow contents. Caller output is separate from logs. Synthetic observations go to the model provider; this is not a universal redaction system.

Controls and policies need human review when an application changes: a familiar label does not prove safe behavior. Local operator control is cooperative, not tamper-proof or OS-level mouse fencing. Catalog permissions are host-bound authorization, not remote user authentication.

# Cuts

The implemented scope is one read-oriented browser workflow. The catalog and cross-tenant reuse are the two stretch goals. No native desktop adapter, hosted operator console, distributed workers or LLM recovery during replay is included.

Local journals record interrupted runs and require explicit review before new execution. A guardian cleans up its owned browser after runner death, and old completed evidence can be archived. These measures do not provide crash-session restoration, exactly-once financial effects or high availability.

The suite contains 74 tests. Genuine model discovery and human-operated handoff are supported by saved historical evidence; automated browser tests use scripted models/operators. Next steps for a real deployment would be vendor-specific security review, managed identity/session hosting and broader compatibility tests, not simply more infrastructure. This submission demonstrates the assignment's core, not bank-production readiness.
