# Automation modules

Implemented: model-driven discovery, typed capability compilation, model-free replay, trusted tenant policy, same-live-session handoff and minimized evidence. Discovery is restricted to the configured synthetic member-balance domain, not arbitrary applications. The current boundaries are:

- `contracts/`: versioned capability, result, event, and intervention schemas with runtime validation.
- `replay/web-surface.ts`: browser observation, target resolution, nested-frame health checks, actions and session ownership.
- `discovery/`: bounded LLM observe/decide/act loop and artifact compilation.
- `replay/`: deterministic execution with no model dependency; current implementation supports local web replay only.
- `replay/policy.ts`: default-deny routes/actions, reviewed controls, minimum risk and tenant overrides.
- `replay/evidence.ts`: runtime-validated events and text-free structural diagnostics, including unique intervention snapshots.
- `replay/handoff.ts`: intervention routing and same-session pause/control/resume, including bounded final-output recovery.
- `contracts/outputs.ts`: shared discovery/replay money transform and output validation.
- `catalog/`: named invocation, host-bound authorization, local journals/locks, explicit reconciliation and recoverable retention.

CLIs compose these modules. Replay never calls a model. Native desktop/pixel-only adapters, universal PII redaction, hosted authentication and distributed recovery are not implemented. Browser-guardian cleanup is not session failover. See the root README for commands and contracts/README.md for execution semantics.
