# Computer-use automation

An LLM learns a member-lookup workflow through a real browser. The system saves the workflow as a typed JSON artifact, then replays it with new inputs **without model decisions**.

The target is a local, synthetic banking app. No real bank access or customer data is used.

## Setup

Requires Node.js 22+, npm, and a graphical desktop for human handoff and headed browser tests.

```sh
npm ci
npx playwright install chromium
npm run dev
```

Leave that terminal running. Open http://127.0.0.1:3000 to try the app. If the port is occupied, reuse your existing demo or stop its terminal with Ctrl+C.

## Quick demo: no API key needed

In a second terminal, replay a saved artifact from a genuine model-driven discovery run:

```sh
TENANT_PROFILE=config/tenants/northstar.json HEADLESS=false MEMBER_ID=23456 npm run replay -- evidence/artifacts/discovery-e4e4d137-255d-4366-89eb-853b6babd9f4.json
```

Do not click anything. Expected result: `success`, `checkpointVerified: true`, balance `15603.20`.

Repeat with `MEMBER_ID=99999`. Expected result: `business_outcome`, code `member_not_found`. A missing member is an answer, not a crash.

## Discover a new workflow

Create a local `.env` from [.env.example](.env.example), then set your own `OPENAI_API_KEY` and `OPENAI_MODEL`. Keep this file private. API access and billing are needed only for live discovery, not replay or tests.

With the ordinary app still running:

```sh
TENANT_PROFILE=config/tenants/northstar.json HEADLESS=false GOAL="Find the member using memberId and read their savings balance." npm run discover
```

The model observes the UI and chooses actions. The runner checks each action against trusted policy. Successful discovery prints the saved artifact path and an exact replay command.

Run that printed command with `MEMBER_ID=23456` to reuse the new artifact. Do not replace it with the older example when checking your new recording.

Discovery is intentionally limited to this member-balance domain. The model chooses the sequence and observed controls; input/output definitions, approved static controls and known business outcomes are supplied by code/configuration. An ordinary discovery run validates its goal and outputs; an assisted recording also needs separate model-free replay verification before saving.

## Human handoff: expired session

Start the expiry fixture in another terminal:

```sh
PORT=3001 DEMO_HANDOFF=false DEMO_SESSION_EXPIRY=true npm run dev
```

Then run:

```sh
HUMAN_HANDOFF=true TENANT_PROFILE=config/tenants/northstar-expiry.json MEMBER_ID=12345 npm run replay -- evidence/artifacts/discovery-e4e4d137-255d-4366-89eb-853b6babd9f4.json
```

When the terminal says **Human control active**:

1. Click **Restore demo session** in that run's existing browser.
2. Wait for the account page to load.
3. Type `resume` in the terminal, or `abort` to cancel.

Automation checks the restored access and correct member before returning the balance. It never repeats the interrupted action. The expired login is synthetic; the live-session transfer is real.

For assisted discovery and the operator-check fixture, follow [DEMO_GUIDE.md](DEMO_GUIDE.md). Discovery and independent verification are separate runs, so each can request human help.

## Two optional demonstrations

**Callable catalog:** with port 3000 running:

```sh
npm run catalog:demo
```

This lists typed capabilities and invokes one by name. Trusted host code binds the caller and tenant. It is an in-process interface, not a hosted API.

**Same artifact, second tenant:** start Cedar separately:

```sh
PORT=3002 DEMO_VARIANT=cedar DEMO_HANDOFF=false DEMO_SESSION_EXPIRY=false npm run dev
```

Then:

```sh
npm run tenants:verify
```

Both tenants should succeed with the same artifact hash. A reviewed tenant override handles Cedar's different search-button label.

## Tests and evidence

```sh
npm run typecheck
npm run build
npm test
npm run capability:validate
npm run evidence:verify
```

Tests do not call the model. The browser tests start temporary local fixtures; they need loopback networking and Chromium, and some need a desktop. `evidence:verify` needs the ordinary port-3000 demo.

The suite covers inputs/contracts, policy, redaction boundaries, real-browser discovery/replay, runtime errors, handoff, tenant changes and local interruption handling. See [evidence/README.md](evidence/README.md) for selected recorded runs and [REPORT.md](REPORT.md) for design decisions.

To exercise runtime faults manually, replace the port-3001 server with `PORT=3001 DEMO_RUNTIME=permission npm run dev`, then use `TENANT_PROFILE=config/tenants/northstar-handoff.json MEMBER_ID=12345 npm run replay`. Other modes: `validation`, `app_error`, `slow`, `known_dialog`, `unknown_dialog`. Stop the previous fixture before changing modes; keep other fault flags unset.

## Code map

| Location | Responsibility |
|---|---|
| `src/demo/` | Synthetic app, records and failure fixtures |
| `src/automation/contracts/` | Versioned schemas and shared output validation |
| `src/automation/discovery/` | Model adapter, discovery loop and artifact compilation |
| `src/automation/replay/` | Model-free engine, browser adapter, policy, handoff and evidence |
| `src/automation/catalog/` | Named invocation, local authorization and run journals |
| `config/tenants/` | Trusted app settings, controls and tenant overrides |

The [contract guide](src/automation/contracts/README.md) explains schema 1.0/1.1 and execution rules. The hand-authored example under `examples/` is not discovery evidence.

## Safety and limits

- Runtime policy restricts origins, routes, requests, action types and reviewed controls. Artifact risk cannot override trusted minimum risk. Unknown controls and irreversible actions are blocked.
- A run returns success, a known business outcome, or a typed failure. Waits are bounded; uncertain clicks are not retried.
- HTTP errors and configured markers in nested frames stop automation. Restoring a parent does not clear an expired child.
- Handoff preserves the same browser, records safe action metadata and saves a reason/step plus a text-free structural diagnostic. Final-output recovery discards partial results and rechecks the goal.
- Logs omit page text, input values and raw model responses. Discovery saves only approved static target descriptions. Observations sent to the provider are synthetic; disabling response storage is not a guarantee of zero provider retention.
- Discovery observation and diagnostics cover the top document; replay also supports reviewed frame targets. Native desktop and pixel-only automation are not implemented.
- Human control is cooperative and local, not a secure remote console. Version checks are optional profile settings. This is not a bank-production deployment.

## Local run maintenance

`npm run runs:inspect` lists tracked catalog and direct CLI runs. A recorded ending can be success, a business outcome or failure.

Interrupted work is never automatically retried. After reviewing its effects, use `npm run runs:reconcile -- execution` (or `catalog`) for the explicit local-operator process. Live or uncertain owners block reconciliation.

`npm run runs:retention -- execution` previews completed records older than 30 days; append `--apply` to archive them recoverably. Unresolved runs and artifacts stay untouched. A browser guardian closes its own browser after runner death; it does not restore a lost session or undo application effects.

See [REPORT.md](REPORT.md) for design choices and [evidence/README.md](evidence/README.md) for recorded examples.
