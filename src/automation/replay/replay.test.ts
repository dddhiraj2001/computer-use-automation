import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { capabilitySchema } from "../contracts/capability.js";
import { replay } from "./engine.js";
import { tenantProfileSchema, destinationAllowed, specialize, authorizeStep } from "./policy.js";
import { RunError, type SurfaceAdapter, type EvidenceSink } from "./ports.js";
import { WebSurface } from "./web-surface.js";
import { HandoffCoordinator } from "./handoff.js";
import { FileEvidence } from "./evidence.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const artifact = capabilitySchema.parse(JSON.parse(readFileSync("examples/member-balance.capability.json", "utf8")));
const tenant = tenantProfileSchema.parse(JSON.parse(readFileSync("config/tenants/northstar.json", "utf8")));
test("final-stage handoff rechecks identity, discards partial outputs and never repeats actions", async () => {
  for (const scenario of ["read", "checkpoint", "abort", "persistent", "wrong_member", "hard_failure"] as const) {
    const h = harness();
    const cap = structuredClone(artifact);
    cap.outputs.second = structuredClone(cap.outputs.balance!);
    cap.extract.push({ output: "second", target: "balance", transform: "usd_money_to_decimal" });
    let reads = 0, handoffs = 0, restored = false, checks = 0;
    h.surface.beginManual = async () => {};
    h.surface.endManual = async () => {};
    h.surface.matches = async condition => {
      if (["notFound", "validationRejected"].includes(condition.target)) return false;
      if (condition.target === "memberIdentity") {
        checks++;
        if (scenario === "checkpoint" && checks === 2) throw new RunError("session_expired", "Expired during final checkpoint.");
        if (scenario === "wrong_member" && restored) throw new RunError("checkpoint_failed", "Member identity does not match.");
      }
      return true;
    };
    h.surface.read = async () => {
      reads++;
      if (scenario !== "checkpoint" && ((!restored && reads === 2) || scenario === "persistent")) {
        throw new RunError(scenario === "hard_failure" ? "permission_denied" : "session_expired", "Read blocked.");
      }
      return restored ? "$2.00" : "$1.00";
    };
    const result = await replay({ ...h.options, artifact: cap, intervention: { request: async context => {
      handoffs++; assert.equal(context.stepId, "final-output"); restored = true;
      return scenario === "abort" ? "abort" : "resume";
    } } });
    assert.equal(h.acts(), 4);
    assert.equal(handoffs, scenario === "hard_failure" ? 0 : 1);
    if (scenario === "read" || scenario === "checkpoint") {
      assert.equal(result.status, "success");
      if (result.status === "success") assert.deepEqual(result.outputs, { balance: "2.00", second: "2.00" });
    } else {
      assert.equal(result.status, "failure");
      if (result.status === "failure") assert.equal(result.code, scenario === "abort" ? "human_aborted" :
        scenario === "wrong_member" ? "checkpoint_failed" : scenario === "hard_failure" ? "permission_denied" : "session_expired");
    }
  }
});
test("trusted control risk cannot be downgraded or bypassed with unknown targets, fallbacks or frames", () => {
  const cap = structuredClone(artifact);
  const step = cap.steps[2]!;
  step.risk = "read_only";
  const target = cap.targets.searchButton!;
  const denied = (profile = tenant) => assert.throws(() => authorizeStep(step, profile, cap),
    error => error instanceof RunError && error.code === "policy_denied");
  authorizeStep(step, tenant, cap);
  denied({ ...tenant, reviewedControls: [] });
  target.strategies = [{ kind: "role", role: "button", name: "Delete account", exact: true }];
  denied();
  const trusted = { ...tenant, reviewedControls: [{ target: structuredClone(target), actions: ["click" as const], minimumRisk: "irreversible" as const }] };
  denied(trusted);
  denied({ ...trusted, maximumRisk: "irreversible" });
  // Even a reviewed reversible action cannot be downgraded to pass a read-only runtime policy.
  denied({ ...trusted, maximumRisk: "read_only", reviewedControls: [{ ...trusted.reviewedControls[0]!, minimumRisk: "reversible" }] });
  target.strategies = structuredClone(artifact.targets.searchButton!.strategies);
  target.strategies.push({ kind: "css", selector: "button.dangerous" });
  denied();
  target.strategies = structuredClone(artifact.targets.searchButton!.strategies);
  target.framePath = ["iframe"];
  denied();
});

test("successful handoffs persist reason and distinct sanitized diagnostics before transferring control", async () => {
  const directory = await mkdtemp(join(tmpdir(), "handoff-evidence-"));
  const evidence = new FileEvidence(directory, "test", "handoff");
  const references: string[] = [];
  let transfers = 0;
  const surface = { diagnostics: async () => ({ surface: "web", sessionOpen: true, controlCount: 2 }),
    beginManual: async () => { transfers++; }, endManual: async () => {} };
  try {
    for (const reason of ["session_expired", "operator_required"] as const) {
      await new HandoffCoordinator().run({ surface, timeoutMs: 1000,
        context: { runId: "handoff", capabilityId: "member.read-savings-balance", stepId: "search-member", reason },
        saveDiagnostic: (value, purpose) => evidence.diagnostic(value, purpose),
        audit: async (phase, code, manualAction, intervention) => {
          await evidence.append({ phase, code, stepIndex: 2, ...(manualAction ? { manualAction } : {}), ...(intervention ? { intervention } : {}) });
          if (intervention) {
            references.push(intervention.diagnostic);
            const saved = JSON.parse(await readFile(join(directory, "test", "handoff", intervention.diagnostic), "utf8"));
            assert.equal(saved.sessionOpen, true);
            assert.equal(transfers, references.length - 1);
          }
        }, handler: { request: async () => "resume" } });
    }
    assert.equal(new Set(references).size, 2);
    const events = (await readFile(join(directory, "test", "handoff", "events.redacted.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.filter(event => event.intervention).map(event => event.intervention.reason), ["session_expired", "operator_required"]);
    await evidence.diagnostic({ surface: "web", sessionOpen: false, controlCount: 0 });
    for (const reference of references) assert.equal(JSON.parse(await readFile(join(directory, "test", "handoff", reference), "utf8")).sessionOpen, true);
    await assert.rejects(() => evidence.append({ phase: "intent", stepIndex: 2, code: "intervention_requested",
      intervention: { reason: "session_expired", stepId: "search-member", diagnostic: "../../secret.json" } }));
    await assert.rejects(() => evidence.append(Object.assign({ phase: "intent" as const, stepIndex: 2, code: "intervention_requested" }, {
      intervention: { reason: "session_expired" as const, stepId: "search-member", diagnostic: references[0]!, rawText: "private-name-token" }
    })));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("intervention diagnostic persistence failure prevents control transfer", async () => {
  let transferred = false;
  await assert.rejects(() => new HandoffCoordinator().run({ timeoutMs: 100,
    context: { runId: "test", capabilityId: "test", stepId: "step", reason: "session_expired" },
    surface: { diagnostics: async () => ({ surface: "web", sessionOpen: true, controlCount: 1 }),
      beginManual: async () => { transferred = true; }, endManual: async () => {} },
    saveDiagnostic: async () => { throw new Error("storage unavailable"); }, audit: async () => {},
    handler: { request: async () => { throw new Error("must not request"); } } }));
  assert.equal(transferred, false);
});
function harness() {
  let acts = 0;
  let polls = 0;
  let closed = false;
  const events: unknown[] = [];
  const surface: SurfaceAdapter = {
    features: ["structured_targets"], start: async () => {},
    act: async () => { acts++; },
    matches: async condition => {
      if (["notFound", "validationRejected"].includes(condition.target)) return false;
      if (condition.target === "viewAccount") return ++polls > 2;
      return true;
    },
    read: async () => "$8,240.75",
    diagnostics: async () => ({ surface: "fake", sessionOpen: true, controlCount: 3 }),
    close: async () => { closed = true; }
  };
  const evidence: EvidenceSink = { append: async value => { events.push(value); }, diagnostic: async () => "diagnostic.json" };
  const options = { runId: "run-1", artifact, tenant, inputs: { memberId: "12345" }, createSurface: () => surface, evidence };
  return { surface, evidence, options, events, acts: () => acts, closed: () => closed };
}
test("delayed postconditions are polled and output is validated without a browser dependency", async () => {
  const h = harness(); const result = await replay(h.options);
  assert.equal(result.status, "success");
  if (result.status === "success") assert.equal(result.outputs.balance, "8240.75");
  assert.equal(h.acts(), 4); assert.equal(h.closed(), true);
  assert.equal(JSON.stringify(h.events).includes("12345"), false);
});
test("invalid input yields structured failure before session creation", async () => {
  const h = harness(); let created = false;
  const result = await replay({ ...h.options, inputs: { memberId: "bad" }, createSurface: () => { created = true; return h.surface; } });
  assert.equal(result.status, "failure");
  if (result.status === "failure") { assert.equal(result.code, "invalid_input"); assert.equal(result.interventionAvailable, false); }
  assert.equal(created, false);
});

test("failed condition reports its position and kind without sensitive comparison text", async () => {
  const h = harness();
  const modified = structuredClone(artifact);
  modified.steps[0]!.timeoutMs = 100;
  modified.steps[0]!.preconditions = [{ kind: "text_equals", target: "searchField", value: "private-comparison-value" }];
  h.surface.matches = async () => false;
  const result = await replay({ ...h.options, artifact: modified });
  assert.equal(result.status, "failure");
  if (result.status === "failure") {
    assert.equal(result.code, "checkpoint_failed");
    assert.match(result.observedRedacted, /precondition 1 \(text_equals\)/);
    assert.match(result.observedRedacted, /match=false/);
  }
  assert.equal(JSON.stringify(result).includes("private-comparison-value"), false);
  assert.equal(h.acts(), 0);
});

test("declared human checkpoint requires operator, schema version and verified postconditions", async () => {
  const modified = structuredClone(artifact);
  modified.schemaVersion = "1.1";
  modified.compatibility.requiredFeatures.push("manual_control");
  modified.steps[2]!.humanCheckpoint = { reason: "operator_required",
    instructions: "Resolve the operator-only state, then resume; the step postconditions must pass." };
  assert.equal(capabilitySchema.safeParse({ ...modified, schemaVersion: "1.0" }).success, false);
  for (const scenario of ["missing", "resume", "abort", "wrong_state"] as const) {
    const h = harness();
    let handoffs = 0;
    h.surface.beginManual = async () => {};
    h.surface.endManual = async () => {};
    h.surface.matches = async condition => !["notFound", "validationRejected"].includes(condition.target) &&
      !(scenario === "wrong_state" && condition.target === "viewAccount");
    const result = await replay({ ...h.options, artifact: modified,
      createSurface: () => ({ ...h.surface, features: ["structured_targets", "manual_control"] }),
      ...(scenario === "missing" ? {} : { intervention: { request: async () => {
        handoffs++; return scenario === "abort" ? "abort" as const : "resume" as const;
      } } }) });
    if (scenario === "resume") { assert.equal(result.status, "success"); assert.equal(h.acts(), 4); }
    else { assert.equal(result.status, "failure"); if (result.status === "failure")
      assert.equal(result.code, scenario === "missing" ? "operator_required" : scenario === "abort" ? "human_aborted" : "checkpoint_failed"); }
    assert.equal(handoffs, scenario === "missing" ? 0 : 1);
    if (scenario === "missing") assert.equal(h.acts(), 0);
  }
});
test("audit failure prevents UI actions and survives diagnostic storage failure", async () => {
  const h = harness();
  h.evidence.append = async () => { throw new Error("disk unavailable"); };
  h.evidence.diagnostic = async () => { throw new Error("disk unavailable"); };
  const result = await replay(h.options);
  assert.equal(result.status, "failure"); assert.equal(h.acts(), 0); assert.equal(h.closed(), true);
});
test("uncertain click is never retried even when artifact declares it repeat-safe", async () => {
  const h = harness();
  const modified = structuredClone(artifact);
  modified.steps[2]!.retry = { maxAttempts: 3, on: ["transient_timeout"], repeatSafe: true };
  let clicks = 0;
  h.surface.act = async step => { if (step.action === "click") { clicks++; throw new RunError("timeout", "Unknown action outcome."); } };
  const result = await replay({ ...h.options, artifact: modified });
  assert.equal(result.status, "failure"); assert.equal(clicks, 1);
});
test("tenant mismatch and unknown override cannot execute", async () => {
  assert.throws(() => specialize(artifact, { ...tenant, appVersion: "9.0.0" }));
  assert.throws(() => specialize(artifact, { ...tenant, targetOverrides: { unknown: {} } }));
  assert.equal(destinationAllowed("https://example.com/members", tenant, artifact), false);
  assert.equal(destinationAllowed(tenant.origin + "/admin", tenant, artifact), false);
});
test("tenant target overrides preserve the shared workflow and permissions", () => {
  const target = artifact.targets.searchButton!;
  const variant = specialize(artifact, { ...tenant, id: "second-bank", targetOverrides: {
    searchButton: { ...target, strategies: [{ kind: "role", role: "button", name: "Find member", exact: true }] }
  } });
  assert.deepEqual(variant.steps, artifact.steps);
  assert.deepEqual(variant.policy, artifact.policy);
  assert.notDeepEqual(variant.targets.searchButton, artifact.targets.searchButton);
});
test("business outcome wins over absent success-path controls", async () => {
  const h = harness();
  h.surface.matches = async condition => !["viewAccount", "validationRejected"].includes(condition.target);
  const result = await replay(h.options);
  assert.equal(result.status, "business_outcome"); assert.equal(h.acts(), 3);
});
test("redirect is blocked without contacting its destination", async () => {
  let destinationHits = 0;
  const server = createServer((req, res) => {
    if (req.url === "/") { res.writeHead(302, { Location: "/forbidden" }); res.end(); }
    else { destinationHits++; res.end("should never be loaded"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const surface = new WebSurface(artifact, { ...tenant, origin });
  try {
    await surface.start();
    await assert.rejects(() => surface.act(artifact.steps[0]!, {}), error => error instanceof RunError && error.code === "policy_denied");
    assert.equal(destinationHits, 0);
  } finally {
    await surface.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("handoff retains the surface, verifies manual completion, and never repeats the uncertain action", async () => {
  const h = harness(); let owner = "automation"; let count = 0; let starts = 0;
  h.surface.start = async () => { starts++; };
  h.surface.act = async () => { assert.equal(owner, "automation"); if (++count === 3) throw new RunError("timeout", "Uncertain action."); };
  h.surface.matches = async condition => !["notFound", "validationRejected"].includes(condition.target);
  h.surface.beginManual = async record => { owner = "human"; await record("human_click"); };
  h.surface.endManual = async () => { owner = "automation"; };
  const result = await replay({ ...h.options, intervention: { request: async context => {
    assert.equal(owner, "human"); assert.equal(context.stepId, artifact.steps[2]!.id); return "resume";
  } } });
  assert.equal(result.status, "success"); assert.equal(count, 4); assert.equal(starts, 1);
  assert.equal(h.closed(), true); assert.match(JSON.stringify(h.events), /intervention_resolved/);
});

test("handoff abort and invalid manual completion stop without repeating actions", async () => {
  for (const decision of ["abort", "resume"] as const) {
    const h = harness(); let acts = 0;
    h.surface.act = async () => { acts++; throw new RunError("timeout", "Uncertain action."); };
    h.surface.matches = async () => false;
    h.surface.beginManual = async () => {}; h.surface.endManual = async () => {};
    const result = await replay({ ...h.options, intervention: { request: async () => decision } });
    assert.equal(result.status, "failure");
    if (result.status === "failure") assert.equal(result.code, decision === "abort" ? "human_aborted" : "checkpoint_failed");
    assert.equal(acts, 1); assert.equal(h.closed(), true);
  }
});

test("policy denial cannot be bypassed through human handoff", async () => {
  const h = harness(); let requested = false;
  h.surface.act = async () => { throw new RunError("policy_denied", "Blocked."); };
  h.surface.beginManual = async () => {}; h.surface.endManual = async () => {};
  await replay({ ...h.options, intervention: { request: async () => { requested = true; return "resume"; } } });
  assert.equal(requested, false);
});

test("real headed browser transfers control, records operator input, and resumes on the same page", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end('<main><button onclick="document.querySelector(\'section\').hidden=false">Continue lookup</button><section hidden><p>Ready</p></section><p class="intro">12345</p><table><tr><th>Current balance</th><td>$8,240.75</td></tr></table></main>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const modified = structuredClone(artifact);
  modified.steps = [{ ...modified.steps[0]!, timeoutMs: 1000, postconditions: [{ kind: "visible", target: "viewAccount" }] }];
  modified.outcomes = [];
  modified.targets.viewAccount!.strategies = [{ kind: "text", text: "Ready", exact: true }];
  class OperatorTestSurface extends WebSurface {
    async operate() { await this.page!.getByRole("button", { name: "Continue lookup" }).click(); }
    pageIdentity() { return this.page; }
  }
  const surface = new OperatorTestSurface(modified, { ...tenant, origin }, false);
  const events: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), "browser-handoff-evidence-"));
  const diskEvidence = new FileEvidence(directory, "test", "browser-handoff");
  try {
    const result = await replay({ runId: "browser-handoff", artifact: modified, tenant: { ...tenant, origin }, inputs: { memberId: "12345" },
      createSurface: () => surface, evidence: { append: async event => {
        await diskEvidence.append(event);
        events.push(event.code);
        if (event.code === "human_click") { assert.equal(event.manualAction?.tag, "button"); assert.ok(event.manualAction.box.width > 0); }
      }, diagnostic: (value, purpose) => diskEvidence.diagnostic(value, purpose) },
      intervention: { request: async () => {
        const page = surface.pageIdentity();
        await assert.rejects(() => surface.act(modified.steps[0]!, {}), error => error instanceof RunError && error.code === "policy_denied");
        await surface.operate();
        assert.equal(surface.pageIdentity(), page);
        return "resume";
      } } });
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.ok(events.includes("human_click")); assert.ok(events.includes("intervention_resolved"));
    assert.equal(events.filter(code => code === "navigate").length, 2);
    const saved = (await readFile(join(directory, "test", "browser-handoff", "events.redacted.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const request = saved.find(event => event.code === "intervention_requested");
    assert.equal(request.intervention.reason, "checkpoint_failed");
    assert.equal(request.intervention.stepId, modified.steps[0]!.id);
    const snapshot = JSON.parse(await readFile(join(directory, "test", "browser-handoff", request.intervention.diagnostic), "utf8"));
    assert.equal(snapshot.snapshot.format, "structural-dom-v1");
    assert.equal(JSON.stringify(snapshot).includes("12345"), false);
  } finally {
    await surface.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("structural failure evidence excludes injected secrets and rejects unexpected persisted fields", async () => {
  const secret = "PRIVATE_TOKEN_12345";
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<main data-secret="${secret}"><h1>${secret}</h1><input aria-label="${secret}" value="${secret}"><input type="password" value="${secret}"><button disabled>${secret}</button></main>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const profile = { ...tenant, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  const surface = new WebSurface(artifact, profile);
  const directory = await mkdtemp(join(tmpdir(), "safe-evidence-"));
  const evidence = new FileEvidence(directory, "test", "redaction");
  try {
    await surface.start(); await surface.act(artifact.steps[0]!, {});
    const diagnostic = await surface.diagnostics();
    assert.ok(diagnostic.snapshot!.nodes.length > 4);
    assert.ok(diagnostic.snapshot!.nodes.some(node => node.tag === "button" && node.disabled));
    await evidence.diagnostic(diagnostic);
    const saved = await readFile(join(directory, "test", "redaction", "diagnostic.json"), "utf8");
    assert.equal(saved.includes(secret), false); assert.equal(saved.includes("aria-label"), false);
    // Runtime validation, not TypeScript alone, blocks an unexpected raw-content field.
    await assert.rejects(() => evidence.diagnostic(Object.assign({}, diagnostic, { rawText: secret })));
    await assert.rejects(() => evidence.append(Object.assign({ phase: "result" as const, stepIndex: 0, code: "failure" }, { rawText: secret })));
  } finally {
    await surface.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("coordinator rejects reuse, bounds unresponsive operators, and fails closed on audit loss", async () => {
  for (const scenario of ["timeout", "audit", "resume"] as const) {
    const h = harness(); let ended = 0;
    h.surface.beginManual = async () => {};
    h.surface.endManual = async () => { ended++; };
    const coordinator = new HandoffCoordinator();
    const options = { surface: h.surface, timeoutMs: 10, saveDiagnostic: h.evidence.diagnostic,
      context: { runId: "test", capabilityId: "test", stepId: "step", reason: "session_expired" as const },
      audit: async (_phase: string, code: string) => { if (scenario === "audit" && code === "control_human") throw new Error("audit unavailable"); },
      handler: { request: async (): Promise<"resume"> => scenario === "timeout" ? new Promise(() => {}) : "resume" }
    };
    if (scenario === "resume") {
      await coordinator.run(options); assert.equal(coordinator.state, "resolved");
      await assert.rejects(() => coordinator.run(options));
    } else { await assert.rejects(() => coordinator.run(options)); assert.equal(coordinator.state, "aborted"); }
    assert.equal(ended, 1);
  }
});

test("headed viewport follows native window resizing while headless geometry stays fixed", async () => {
  class ResizableSurface extends WebSurface {
    async verify(headless: boolean) {
      const page = this.page!;
      if (headless) {
        assert.deepEqual(page.viewportSize(), { width: 1280, height: 720 });
        return;
      }
      assert.equal(page.viewportSize(), null);
      const session = await page.context().newCDPSession(page);
      try {
        const { windowId } = await session.send("Browser.getWindowForTarget");
        for (const width of [900, 1200]) {
          await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal", width, height: 800 } });
          await page.waitForFunction(expected => Math.abs(window.innerWidth - expected) < 30, width, { timeout: 5000 });
        }
      } finally { await session.detach(); }
    }
  }
  for (const headless of [false, true]) {
    const surface = new ResizableSurface(artifact, tenant, headless);
    try { await surface.start(); await surface.verify(headless); }
    finally { await surface.close(); }
  }
});

test("expired live session resumes only after authorized restoration and correct member verification", async () => {
  for (const scenario of ["restored", "wrong_member", "still_expired", "permission_denied", "abort"] as const) {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      if (req.url === "/") {
        res.statusCode = 401;
        res.end('<main><h1>Session expired</h1><a href="/members/12345">Restore demo session</a></main>');
      } else {
        res.statusCode = scenario === "still_expired" ? 401 : scenario === "permission_denied" ? 403 : 200;
        res.end(`<main><p class="intro">${scenario === "wrong_member" ? "23456" : "12345"}</p><table><tr><th>Current balance</th><td>$8,240.75</td></tr></table><p data-session-state="authenticated" data-permission="member-read">Restored</p></main>`);
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const profile = { ...tenant, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      sessionRecoverySelector: "[data-session-state=authenticated][data-permission=member-read]" };
    const modified = structuredClone(artifact);
    modified.steps = [{ ...modified.steps[0]!, postconditions: modified.checkpoint }]; modified.outcomes = [];
    class RestoringSurface extends WebSurface {
      async restore() { await this.page!.getByRole("link", { name: "Restore demo session" }).click(); }
    }
    const surface = new RestoringSurface(modified, profile, false);
    const h = harness();
    try {
      const result = await replay({ ...h.options, artifact: modified, tenant: profile, createSurface: () => surface,
        intervention: { request: async context => {
          assert.equal(context.reason, "session_expired");
          if (scenario === "abort") return "abort";
          await surface.restore(); return "resume";
        } } });
      if (scenario === "restored") assert.equal(result.status, "success", JSON.stringify(result));
      else {
        assert.equal(result.status, "failure");
        if (result.status === "failure") assert.equal(result.code, {
          wrong_member: "checkpoint_failed", still_expired: "session_expired", permission_denied: "permission_denied", abort: "human_aborted"
        }[scenario]);
      }
      assert.equal(JSON.stringify(h.events).includes("12345"), false);
    } finally { await surface.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});
