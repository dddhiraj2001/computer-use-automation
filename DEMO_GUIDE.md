# Demo guide

These examples use synthetic records. Keep API keys private. Each handoff uses the browser window already opened by that run.

## 1. Start the ordinary application

In terminal A: `PORT=3000 DEMO_HANDOFF=false DEMO_SESSION_EXPIRY=false npm run dev`.
If port 3000 is already occupied by your demo, reuse it or stop that known server first. Do not kill unrelated processes.

The application runs locally with synthetic banking records.

## 2. Model-free normal lookup and not-found

In terminal B: `npm run evidence:verify`.
Expected: one success receipt and one member_not_found receipt; both say modelUsed=false. This uses a genuine previously discovered artifact, with a different member input. No model bill.

To watch the lookup: `HEADLESS=false MEMBER_ID=23456 npm run replay -- evidence/artifacts/discovery-e4e4d137-255d-4366-89eb-853b6babd9f4.json`.

The saved workflow runs without new model decisions.

## 3. Live discovery (paid, optional during presentation)

With local key/model configured privately: `TENANT_PROFILE=config/tenants/northstar.json HEADLESS=false HUMAN_HANDOFF=false npm run discover`.
Expected: saved artifact path after verified goal. Open it to show typed memberId input, balance output, target references and checkpoint—not raw model conversation. A provider outage can prevent this demo; show the existing genuine discovery evidence instead, explicitly identifying it as recorded evidence.

## 4. Login-timeout recovery

Start in another terminal: `PORT=3001 DEMO_HANDOFF=false DEMO_SESSION_EXPIRY=true npm run dev` (stop your earlier port-3001 fixture first).

Run: `HUMAN_HANDOFF=true TENANT_PROFILE=config/tenants/northstar-expiry.json MEMBER_ID=12345 npm run replay -- evidence/artifacts/discovery-e4e4d137-255d-4366-89eb-853b6babd9f4.json`.

Wait for Human control active. Click Restore demo session in that browser. Type `resume` in the terminal. Expected: verified success. Repeat and type `abort` to demonstrate safe cancellation. Restoring access is synthetic; the pause, ownership transfer and resume are real.

## 5. Agent-facing catalog

Run `npm run catalog:demo`. Expected: typed catalog listing followed by successful named invocation through the UI. Run `npm run runs:inspect` afterward: completed ledger record, no inputs or balances stored in the ledger.

Trusted host code binds caller and tenant. An agent supplies the capability name, version and typed arguments. This is an in-process interface, not a hosted API.

## 6. Same artifact, second tenant

Start: `PORT=3002 DEMO_VARIANT=cedar DEMO_HANDOFF=false DEMO_SESSION_EXPIRY=false npm run dev`.
Run: `npm run tenants:verify`.
Expected: both tenants succeed with identical source-artifact hashes. Show cedar.json's reviewed button-label override. This is two separate application processes and browser sessions, not two independently implemented banking products.

## 7. Safety, invalid inputs, authorization and crash tests

Run `npm test`. Named tests demonstrate invalid arguments, unknown callers, cross-tenant/version denial, policy rejection, injected-data exclusion, wrong-member recovery, drift refusal, concurrency rejection, and SIGKILL interruption detection. Clearly describe these as automated tests, not manually triggered live faults.

The crash test kills only its own temporary test process. Do not kill an arbitrary live browser or shell. An unfinished catalog journal requires reconciliation; there is deliberately no “retry anyway” command. Lost browser sessions are not resumed after process death.

## 8. Assisted-artifact checkpoint (secondary test demo)

Stop the port-3001 expiry fixture first. Start the operator-check fixture:

```sh
PORT=3001 DEMO_HANDOFF=true DEMO_SESSION_EXPIRY=false npm run dev
```

In another terminal:

```sh
HUMAN_HANDOFF=true TENANT_PROFILE=config/tenants/northstar-handoff.json GOAL="Find the member using memberId and read their savings balance. Request human help at the operator check." npm run discover
```

Wait for Human control active, click Continue lookup in that run's browser, then type resume. Repeat in the separate model-free verification browser when prompted. These are two separate runs. A later replay of the saved artifact needs only its own handoff.

## Finish

Close the demo servers you started with Ctrl+C. The report describes the scope: local browser automation, synthetic records, cooperative human control, and no hosted authentication or distributed failover.
