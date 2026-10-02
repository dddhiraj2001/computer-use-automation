import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { tenantProfileSchema } from "../replay/policy.js";
import { WebSurface } from "../replay/web-surface.js";
import { replay } from "../replay/engine.js";
import { discover } from "./engine.js";
import { OpenAIModel, type ModelAdapter, type Decision } from "./model.js";
import { searchPage, searchResult, detailPage } from "../../demo/views.js";
import { findMember } from "../../demo/members.js";
import type { EvidenceSink } from "../replay/ports.js";
import { DiscoveryError, discoveryFailure } from "./errors.js";

const observationSchema = z.object({ controls: z.array(z.object({ id: z.string(), text: z.string(), tag: z.string(), filled: z.boolean() })) });

test("discovery and replay apply the same money format and declared output limits", async () => {
  const tenant = tenantProfileSchema.parse(JSON.parse(readFileSync("config/tenants/northstar.json", "utf8")));
  for (const value of ["$1,2.00", "$" + "9".repeat(31) + ".00", "$8,240.75", "$0001.20", "1.20"]) {
    const valid = ["$8,240.75", "$0001.20", "1.20"].includes(value);
    const events: string[] = [];
    const createSurface = () => ({ features: ["structured_targets"], start: async () => {}, close: async () => {},
      act: async () => {}, read: async () => value, matches: async () => true,
      diagnostics: async () => ({ surface: "web", sessionOpen: true, controlCount: 2 }),
      observe: async () => [
        { id: "balance", tag: "td", text: value, filled: false, target: tenant.reviewedControls[3]!.target },
        { id: "identity", tag: "p", text: "Member ID 12345", filled: false, target: tenant.reviewedControls[4]!.target }
      ] });
    const evidence = { append: async (event: Parameters<EvidenceSink["append"]>[0]) => { events.push(event.code); }, diagnostic: async () => "diagnostic.json" };
    const run = () => discover({ runId: "output-test", memberId: "12345", tenant, createSurface, evidence,
      model: { provenance: "scripted_test", decide: async () => ({ action: "finish", target: "balance", input: null, reason: "read_balance" }) } });
    if (valid) {
      const artifact = await run();
      const result = await replay({ runId: "output-replay", artifact, tenant, inputs: { memberId: "12345" }, createSurface, evidence });
      assert.equal(result.status, "success");
    } else {
      await assert.rejects(run, error => error instanceof DiscoveryError && error.code === "invalid_balance");
      assert.equal(events.includes("discovery_verified"), false);
    }
  }
});

test("artifact compilation rejects unreviewed locator text and identity, and discards observed prose", async () => {
  const tenant = tenantProfileSchema.parse(JSON.parse(readFileSync("config/tenants/northstar.json", "utf8")));
  const sensitive = "Account for Alice Example; token test-token-abc";
  for (const scenario of ["locator", "identity", "frame", "fallback", "prose"] as const) {
    const balance = structuredClone(tenant.reviewedControls[3]!.target);
    const identity = structuredClone(tenant.reviewedControls[4]!.target);
    balance.description = sensitive;
    balance.robustness = sensitive;
    identity.description = sensitive;
    if (scenario === "locator") balance.strategies = [{ kind: "role", role: "button", name: sensitive, exact: true }];
    if (scenario === "identity") identity.strategies = [{ kind: "text", text: sensitive, exact: true }];
    if (scenario === "frame") balance.framePath = [sensitive];
    if (scenario === "fallback") balance.strategies.push({ kind: "text", text: sensitive, exact: true });
    const events: unknown[] = [];
    const run = () => discover({ runId: "contamination", memberId: "12345", tenant,
      model: { provenance: "scripted_test", decide: async () => ({ action: "finish", target: "balance", input: null, reason: "read_balance" }) },
      evidence: { append: async event => { events.push(event); }, diagnostic: async () => "diagnostic.json" },
      createSurface: () => ({ start: async () => {}, close: async () => {}, act: async () => {},
        read: async () => "$8,240.75", matches: async () => true,
        diagnostics: async () => ({ surface: "web", sessionOpen: true, controlCount: 2 }),
        observe: async () => [
          { id: "balance", text: "$8,240.75", tag: "td", filled: false, target: balance },
          { id: "identity", text: "Member ID 12345", tag: "p", filled: false, target: identity }
        ] }) });
    if (scenario === "prose") {
      const artifact = await run();
      assert.equal(JSON.stringify(artifact).includes(sensitive), false);
      assert.deepEqual(artifact.targets.memberIdentity, tenant.reviewedControls[4]!.target);
    } else await assert.rejects(run, error => error instanceof DiscoveryError && error.code === "sensitive_target");
    assert.equal(JSON.stringify(events).includes(sensitive), false);
  }
});

test("target retry refreshes observation; repeated invalid targets transfer the same surface and resume", async () => {
  const tenant = tenantProfileSchema.parse(JSON.parse(readFileSync("config/tenants/northstar.json", "utf8")));
  for (const assisted of [false, true]) {
    let observations = 0, calls = 0, handoffs = 0;
    let owner = "automation";
    const actions: string[] = [];
    const events: string[] = [];
    await assert.rejects(discover({ runId: "retry-test", memberId: "12345", tenant, maxSteps: assisted ? 3 : 2,
      model: { provenance: "scripted_test", decide: async raw => {
        calls++;
        const { controls } = observationSchema.parse(raw);
        return { action: "type", target: calls <= (assisted ? 2 : 1) ? "invented" : controls[0]!.id,
          input: "memberId", reason: "search_input" };
      } },
      ...(assisted ? { intervention: { request: async () => {
        assert.equal(owner, "human"); assert.equal(calls, 2); assert.deepEqual(actions, ["navigate"]);
        handoffs++; return "resume" as const;
      } } } : {}),
      evidence: { append: async event => { events.push(event.code); }, diagnostic: async () => "safe.json" },
      createSurface: () => ({ start: async () => {}, close: async () => {},
        act: async step => { assert.equal(owner, "automation"); actions.push(step.action); },
        matches: async () => true, read: async () => "",
        diagnostics: async () => ({ surface: "web", sessionOpen: true, controlCount: 1 }),
        beginManual: async () => { owner = "human"; }, endManual: async () => { owner = "automation"; },
        observe: async () => [{ id: `fresh${++observations}`, text: "Member ID", tag: "input", filled: false,
          target: { description: "Member field", robustness: "Label", framePath: [], strategies: [{ kind: "label", text: "Member ID", exact: true }] } }] })
    }), error => error instanceof DiscoveryError && error.code === "step_limit");
    assert.equal(observations, assisted ? 3 : 2);
    assert.equal(handoffs, assisted ? 1 : 0);
    assert.deepEqual(actions, ["navigate", "type"]);
    assert.equal(events.filter(code => code === "target_selection_retry").length, 1);
  }
});

test("provider target enum is rebuilt from current controls including empty observations", async () => {
  let expected: Array<string | null> = [];
  const transport: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.deepEqual(payload.text.format.schema.properties.target.enum, expected);
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text",
      text: JSON.stringify({ action: "stop", target: null, input: null, reason: "blocked" }) }] }] });
  };
  const provider = new OpenAIModel("test-key", "test-model", "goal", transport);
  for (const ids of [["first", "second"], ["replacement"], []]) {
    expected = [...ids, null];
    await provider.decide({ controls: ids.map(id => ({ id })) }, AbortSignal.timeout(1000));
  }
});

test("invalid discovery decisions stop before action and retain safe failure category and step", async () => {
  const tenant = tenantProfileSchema.parse(JSON.parse(readFileSync("config/tenants/northstar.json", "utf8")));
  for (const scenario of ["invalid_type_reference", "unknown_control", "invalid_click_target", "model_request_failed"] as const) {
    const actions: string[] = [];
    const events: unknown[] = [];
    let closed = false;
    await assert.rejects(discover({ runId: "safe-failure-test", memberId: "12345", tenant,
      model: { provenance: "scripted_test", decide: async () => {
        if (scenario === "model_request_failed") throw new Error("private-token-and-response");
        return { action: scenario === "invalid_type_reference" ? "type" : "click",
          target: scenario === "unknown_control" ? "private-token-and-response" : "field", input: null, reason: "search_input" };
      } },
      evidence: { append: async event => { events.push(event); }, diagnostic: async () => "safe.json" },
      createSurface: () => ({ start: async () => {}, close: async () => { closed = true; },
        act: async step => { actions.push(step.action); }, matches: async () => true, read: async () => "",
        diagnostics: async () => { throw new Error("diagnostics unavailable"); },
        observe: async () => [{ id: "field", text: "Member ID", tag: "input", filled: false,
          target: { description: "Member field", robustness: "Label", framePath: [], strategies: [{ kind: "label", text: "Member ID", exact: true }] } }] })
    }), error => error instanceof DiscoveryError && error.code === scenario);
    assert.deepEqual(actions, ["navigate"]);
    assert.equal(closed, true);
    assert.deepEqual(events.at(-1), { phase: "result", stepIndex: scenario === "unknown_control" ? 2 : 1, code: `discovery_failed_${scenario}` });
    assert.equal(JSON.stringify(events).includes("private-token-and-response"), false);
  }
  assert.equal(JSON.stringify(discoveryFailure(new Error("private-token-and-response"))).includes("private-token-and-response"), false);
});
const model: ModelAdapter = { provenance: "scripted_test", decide: async observation => {
  const { controls } = observationSchema.parse(observation);
  const balance = controls.find(control => control.tag === "td" && control.text.startsWith("$"));
  const detail = controls.find(control => control.text === "View account");
  const input = controls.find(control => control.tag === "input");
  const button = controls.find(control => control.tag === "button");
  if (balance) return { action: "finish", target: balance.id, input: null, reason: "read_balance" };
  if (detail) return { action: "click", target: detail.id, input: null, reason: "open_details" };
  if (input && !input.filled) return { action: "type", target: input.id, input: "memberId", reason: "search_input" };
  if (button) return { action: "click", target: button.id, input: null, reason: "submit_search" };
  return { action: "stop", target: null, input: null, reason: "blocked" };
} };

test("scripted discovery operates real UI, compiles safe artifact, and replays different inputs without model calls", async () => {
  let operatorMode = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "text/html");
    if (url.pathname === "/") res.end(searchPage());
    else if (url.pathname === "/members") {
      if (operatorMode && !url.searchParams.has("reviewed")) {
        res.end('<main><form action="/members"><input type="hidden" name="memberId" value="12345"><input type="hidden" name="reviewed" value="yes"><button>Continue lookup</button></form></main>');
        return;
      }
      const id = url.searchParams.get("memberId") ?? "";
      const member = findMember(id);
      res.end(searchPage(id, member ? searchResult(member) : '<p>Member not found. Check the member ID and try again.</p>'));
    } else if (url.pathname.startsWith("/members/")) {
      const member = findMember(url.pathname.split("/")[2] ?? "");
      res.end(member ? detailPage(member) : "Not found");
    } else { res.setHeader("Content-Type", "text/css"); res.end(""); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const tenant = tenantProfileSchema.parse({ ...JSON.parse(readFileSync("config/tenants/northstar.json", "utf8")), origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  const events: unknown[] = [];
  const evidence: EvidenceSink = { append: async event => { events.push(event); }, diagnostic: async () => "diagnostic.json" };
  try {
    const artifact = await discover({ runId: "scripted-only", memberId: "12345", tenant, model, evidence, createSurface: draft => new WebSurface(draft, tenant) });
    assert.equal(artifact.metadata.source, "hand_authored");
    assert.equal(artifact.steps.length, 4);
    for (const sensitive of ["12345", "8240.75", "8,240.75", "Alex Morgan"]) {
      assert.equal(JSON.stringify(artifact).includes(sensitive), false);
      assert.equal(JSON.stringify(events).includes(sensitive), false);
    }
    for (const memberId of ["23456", "99999"]) {
      const result = await replay({ runId: `run-${memberId}`, artifact, inputs: { memberId }, tenant, evidence, createSurface: cap => new WebSurface(cap, tenant) });
      if (memberId === "23456") { assert.equal(result.status, "success"); if (result.status === "success") assert.equal(result.outputs.balance, "15603.20"); }
      else { assert.equal(result.status, "business_outcome"); if (result.status === "business_outcome") assert.equal(result.code, "member_not_found"); }
    }
    await assert.rejects(() => discover({ runId: "limited", memberId: "12345", tenant, model, evidence, maxSteps: 1, createSurface: draft => new WebSurface(draft, tenant) }), /step limit/);
    const bad: ModelAdapter = { provenance: "scripted_test", decide: async () => ({ action: "click", target: "invented", input: null, reason: "open_details" }) };
    await assert.rejects(() => discover({ runId: "invalid-target", memberId: "12345", tenant, model: bad, evidence, createSurface: draft => new WebSurface(draft, tenant) }), /unknown control/);
    // A model-requested handoff resumes on the same page, but manual navigation cannot
    // silently disappear from the artifact: verify it in a separate, unassisted session.
    class OperatorSurface extends WebSurface {
      async skipToDetails() { await this.page!.goto(`${tenant.origin}/members/12345`); }
    }
    for (const scenario of ["resume", "skip", "abort"] as const) {
      let first = true;
      let surface: OperatorSurface | undefined;
      let verificationCount = 0;
      const assistedModel: ModelAdapter = { provenance: "scripted_test", decide: async (observation, signal) => {
        if (first) { first = false; return { action: "stop", target: null, input: null, reason: "blocked" }; }
        return model.decide(observation, signal);
      } };
      const run = () => discover({ runId: `assisted-${scenario}`, memberId: "12345", tenant, model: assistedModel, evidence,
        createSurface: draft => { surface = new OperatorSurface(draft, tenant, false); return surface; },
        intervention: { request: async context => {
          assert.equal(context.phase, "discovery");
          if (scenario === "skip") await surface!.skipToDetails();
          return scenario === "abort" ? "abort" : "resume";
        } },
        verifyArtifact: async candidate => {
          verificationCount++;
          const result = await replay({ runId: "assisted-verification", artifact: candidate, inputs: { memberId: "12345" }, tenant,
            evidence, createSurface: cap => new WebSurface(cap, tenant), timeoutMs: 1500 });
          return result.status === "success";
        }
      });
      if (scenario === "resume") { const verified = await run(); assert.equal(verified.steps.length, 4); }
      else await assert.rejects(run, scenario === "abort" ? /aborted/ : /independent replay/i);
      assert.equal(verificationCount, scenario === "abort" ? 0 : 1);
    }
    operatorMode = true;
    const guardedTenant = tenantProfileSchema.parse({ ...tenant, operatorRequiredSelectors: ['button:text-is("Continue lookup")'] });
    class CheckpointSurface extends WebSurface {
      async continueManually() { await this.page!.getByRole("button", { name: "Continue lookup" }).click(); }
    }
    let discoverySurface: CheckpointSurface;
    let verificationSurface: CheckpointSurface;
    let modelCalls = 0, manualCount = 0;
    const compiled = await discover({ runId: "operator-checkpoint", memberId: "12345", tenant: guardedTenant, evidence,
      model: { provenance: "scripted_test", decide: async (observation, signal) => { modelCalls++; return model.decide(observation, signal); } },
      createSurface: draft => discoverySurface = new CheckpointSurface(draft, guardedTenant, false),
      intervention: { request: async () => { manualCount++; await discoverySurface.continueManually(); return "resume"; } },
      verifyArtifact: async candidate => {
        assert.equal(candidate.schemaVersion, "1.1");
        assert.equal(candidate.steps.filter(step => step.humanCheckpoint).length, 1);
        const before = modelCalls;
        const result = await replay({ runId: "checkpoint-verification", artifact: candidate, inputs: { memberId: "12345" },
          tenant: guardedTenant, evidence,
          createSurface: cap => verificationSurface = new CheckpointSurface(cap, guardedTenant, false),
          intervention: { request: async () => { manualCount++; await verificationSurface.continueManually(); return "resume"; } } });
        assert.equal(modelCalls, before);
        return result.status === "success";
      } });
    assert.equal(manualCount, 2);
    assert.equal(compiled.steps.length, 4);
    assert.equal(JSON.stringify(compiled).includes("Continue lookup"), false);
    assert.ok(events.some(event => {
      const parsed = z.object({ code: z.string(), intervention: z.object({ reason: z.string(), stepId: z.string(), diagnostic: z.string() }).optional() }).parse(event);
      return parsed.code === "intervention_requested" && parsed.intervention?.reason === "operator_required" && parsed.intervention.stepId.startsWith("discovery-");
    }));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("provider uses structured output and disables response storage", async () => {
  const decision: Decision = { action: "stop", target: null, input: null, reason: "blocked" };
  const transport: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.store, false); assert.equal(payload.text.format.strict, true);
    assert.ok(init?.signal);
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
  };
  assert.deepEqual(await new OpenAIModel("test-key", "test-model", "test-goal", transport).decide({ controls: [] }, AbortSignal.timeout(1000)), decision);
});
test("provider refuses incomplete responses and omits error bodies", async () => {
  const unavailable: typeof fetch = async () => new Response("secret-body", { status: 401 });
  await assert.rejects(() => new OpenAIModel("test-key", "test-model", "goal", unavailable).decide({ controls: [] }, AbortSignal.timeout(1000)), error => error instanceof Error && error.message.includes("401") && !error.message.includes("secret-body"));
  const incomplete: typeof fetch = async () => Response.json({ status: "incomplete", output: [] });
  await assert.rejects(() => new OpenAIModel("test-key", "test-model", "goal", incomplete).decide({ controls: [] }, AbortSignal.timeout(1000)));
});
