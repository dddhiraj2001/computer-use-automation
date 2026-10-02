# Recorded examples

These files show real UI discovery, saved workflows, model-free replay and human handoff on the synthetic demo app. Logs omit input values, balances and raw model responses.

## Start here

| Example | Files |
|---|---|
| LLM discovery | [Artifact](artifacts/discovery-e4e4d137-255d-4366-89eb-853b6babd9f4.json) · [Discovery log](discovery/northstar/discovery-e4e4d137-255d-4366-89eb-853b6babd9f4/events.redacted.jsonl) |
| Successful replay | [Receipt](release/northstar/release-20adfc80-4d4b-4c50-814f-c001bcb7189d/receipt.json) · [Log](release/northstar/release-20adfc80-4d4b-4c50-814f-c001bcb7189d/events.redacted.jsonl) |
| Member not found | [Receipt](release/northstar/release-007ce073-ffde-45f5-aafc-a88c011d5305/receipt.json) · [Log](release/northstar/release-007ce073-ffde-45f5-aafc-a88c011d5305/events.redacted.jsonl) |
| Session-expiry recovery | [Human handoff log](runs/northstar-expiry/replay-a58cc66f-d1f7-4d6c-a788-6d418a19b2ed/events.redacted.jsonl) |
| Assisted discovery | [Artifact](artifacts/discovery-62959145-932d-4972-b0d0-93e42be67314.json) · [Discovery log](discovery/northstar-handoff/discovery-62959145-932d-4972-b0d0-93e42be67314/events.redacted.jsonl) · [Separate verification](runs/northstar-handoff/verification-6665af0c-88fe-4796-8e1c-3cb1e6b7ff7f/events.redacted.jsonl) |
| Failure diagnostic | [Structural snapshot](runs/northstar-handoff/replay-a54aba13-94ae-40a0-b32a-60b78c778654/diagnostic.json) · [Log](runs/northstar-handoff/replay-a54aba13-94ae-40a0-b32a-60b78c778654/events.redacted.jsonl) |
| Named capability invocation | [Catalog log](catalog/northstar/catalog-34dd1f32-7c7a-4c33-ac67-115111422a16/events.redacted.jsonl) |
| Same artifact across tenants | [Northstar receipt](tenants/northstar/tenant-30046abf-f899-4d02-bdf1-913697c57d3b/receipt.json) · [Cedar receipt](tenants/cedar/tenant-33bff36c-2b6a-4f3b-b4a7-493b6e663367/receipt.json) |

## Reading the records

Discovery logs record model-selected action categories, not a raw transcript. Replay receipts identify the artifact and outcome, omit output values and state that no model was used. Human logs record control transfer, manual events and resume/abort.

The failure snapshot is a bounded structural DOM description: geometry, hierarchy and control state, without page text or input values. The linked failure is an operator-check run without an operator, not a session-expiry recovery.

These are recorded runs, not claims that a model or person participated in every automated test. Older runs predate newer diagnostic fields. Other saved logs include failed and cancelled runs; their recorded results remain unchanged.

## Reproduce

With the ordinary app running on port 3000:

```sh
npm run evidence:verify
```

For handoff, discovery, catalog and tenant examples, see the [demo guide](../DEMO_GUIDE.md). All records use synthetic data. Do not save real customer data or credentials here.
