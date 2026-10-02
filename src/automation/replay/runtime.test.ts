import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { capabilitySchema } from "../contracts/capability.js";
import { tenantProfileSchema } from "./policy.js";
import { replay } from "./engine.js";
import { WebSurface } from "./web-surface.js";
import { RunError, type SurfaceAdapter } from "./ports.js";
import { searchPage, searchResult, detailPage } from "../../demo/views.js";
import { findMember } from "../../demo/members.js";
import { operatorInstructions } from "./terminal-operator.js";

test("operator guidance explains login recovery, synthetic checks and safe cancellation", () => {
  assert.match(operatorInstructions("session_expired"), /Restore demo session/);
  assert.match(operatorInstructions("session_expired"), /never enter credentials/);
  assert.match(operatorInstructions("operator_required"), /not a real banking approval/);
  assert.match(operatorInstructions("checkpoint_failed"), /abort if you are unsure/);
});

const base = capabilitySchema.parse(JSON.parse(readFileSync("examples/member-balance.capability.json", "utf8")));
const profile = tenantProfileSchema.parse(JSON.parse(readFileSync("config/tenants/northstar.json", "utf8")));

test("nested frame HTTP and configured marker errors cannot produce successful replay", async () => {
  for (const scenario of ["ok", "401", "403", "503", "ui_error", "operator"] as const) {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      if (req.url === "/") res.end('<main><iframe src="/members"></iframe></main>');
      else if (req.url === "/members") res.end('<iframe src="/members/12345"></iframe>');
      else {
        res.statusCode = ["401", "403", "503"].includes(scenario) ? Number(scenario) : 200;
        res.end(`<main><p class="intro">Member ID 12345</p><table><tr><th>Current balance</th><td>$8,240.75</td></tr></table>${scenario === "ui_error" ? '<p id="error">Error</p>' : scenario === "operator" ? '<button>Continue lookup</button>' : ""}</main>`);
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const cap = structuredClone(base);
    cap.steps = [cap.steps[0]!];
    cap.steps[0]!.postconditions = cap.checkpoint;
    cap.outcomes = [];
    cap.compatibility.requiredFeatures.push("frames");
    for (const target of Object.values(cap.targets)) target.framePath = ["iframe", "iframe"];
    const tenant = tenantProfileSchema.parse({ ...profile, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      uiFailures: [{ selector: "#error", code: "app_error" }], operatorRequiredSelectors: ['button:text-is("Continue lookup")'] });
    try {
      const result = await replay({ runId: "frame-test", artifact: cap, tenant, inputs: { memberId: "12345" },
        createSurface: (artifact, config) => new WebSurface(artifact, config),
        evidence: { append: async () => {}, diagnostic: async () => "diagnostic.json" } });
      assert.equal(result.status, scenario === "ok" ? "success" : "failure", JSON.stringify(result));
      if (result.status === "failure") assert.equal(result.code, scenario === "401" ? "session_expired" :
        scenario === "403" ? "permission_denied" : scenario === "operator" ? "operator_required" : "app_error");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

test("iframe expiry recovery requires the affected frame to restore, not just a healthy parent", async () => {
  for (const restore of [false, true]) {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      if (req.url === "/") res.end('<main data-access="yes"><iframe src="/members"></iframe></main>');
      else if (req.url === "/members") { res.statusCode = 401; res.end('<main><a href="/members/12345">Restore</a></main>'); }
      else res.end('<main data-access="yes"><p class="intro">12345</p><table><tr><th>Current balance</th><td>$8,240.75</td></tr></table></main>');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const cap = structuredClone(base);
    cap.steps = [cap.steps[0]!]; cap.steps[0]!.postconditions = cap.checkpoint; cap.outcomes = [];
    for (const target of Object.values(cap.targets)) target.framePath = ["iframe"];
    const tenant = tenantProfileSchema.parse({ ...profile, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sessionRecoverySelector: "[data-access=yes]" });
    class OperatorSurface extends WebSurface {
      async restore() {
        await this.page!.frameLocator("iframe").getByRole("link", { name: "Restore" }).click();
        await this.page!.frameLocator("iframe").locator("[data-access=yes]").waitFor({ state: "visible" });
      }
    }
    let surface: OperatorSurface;
    try {
      const result = await replay({ runId: "frame-recovery", artifact: cap, tenant, inputs: { memberId: "12345" },
        createSurface: (artifact, config) => surface = new OperatorSurface(artifact, config, false),
        intervention: { request: async () => { if (restore) await surface.restore(); return "resume"; } },
        evidence: { append: async () => {}, diagnostic: async () => "diagnostic.json" } });
      assert.equal(result.status, restore ? "success" : "failure", JSON.stringify(result));
      if (result.status === "failure") assert.equal(result.code, "session_expired");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

test("operator boundary blocks observation and automated clicks; only live manual completion releases it", async () => {
  let continued = 0;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/members") { continued++; res.end("<main>Completed</main>"); }
    else res.end('<main><form action="/members"><button>Continue lookup</button></form></main>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const tenant = tenantProfileSchema.parse({ ...profile, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    operatorRequiredSelectors: ['button:text-is("Continue lookup")'] });
  const cap = structuredClone(base);
  cap.targets.operator = { description: "Operator control", robustness: "Exact name", framePath: [],
    strategies: [{ kind: "role", role: "button", name: "Continue lookup", exact: true }] };
  class ManualSurface extends WebSurface {
    async manualClick() { await this.page!.getByRole("button", { name: "Continue lookup" }).click(); }
  }
  const surface = new ManualSurface(cap, tenant, false);
  const blocked = (error: unknown) => error instanceof RunError && error.code === "operator_required";
  try {
    await surface.start();
    await assert.rejects(surface.act(cap.steps[0]!, {}), blocked);
    await assert.rejects(surface.observe(), blocked);
    await assert.rejects(surface.act({ ...cap.steps[0]!, action: "click", target: "operator" }, {}), blocked);
    assert.equal(continued, 0);
    await surface.beginManual(async () => {});
    await surface.manualClick();
    await surface.endManual();
    assert.equal(continued, 1);
    await surface.observe();
  } finally {
    await surface.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const scenario of ["validation", "permission", "server_error", "ui_error", "slow", "known_alert", "unknown_confirm", "repeated_alert"] as const) {
  test(`runtime browser: ${scenario}`, async () => {
    const cap = structuredClone(base);
    cap.steps = [{ ...cap.steps[0]!, postconditions: cap.checkpoint }];
    cap.outcomes = [{ code: "validation_rejected", description: "Rejected", when: [{ kind: "visible", target: "validationRejected" }], afterSteps: [cap.steps[0]!.id] }];
    const events: string[] = [];
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.statusCode = scenario === "permission" ? 403 : scenario === "server_error" ? 503 : scenario === "validation" ? 422 : 200;
      const script = scenario === "known_alert" ? 'alert("Demo informational notice")' : scenario === "unknown_confirm" ? 'confirm("Sensitive unknown message")' : scenario === "repeated_alert" ? 'alert("Demo informational notice");alert("Demo informational notice")' : "";
      const html = `<main><p class="intro">12345</p>${scenario === "validation" ? '<p>Lookup rejected by application validation.</p>' : ''}${scenario === "ui_error" ? '<p data-app-error>Private error text</p>' : ''}<table><tr><th>Current balance</th><td>$8,240.75</td></tr></table><script>${script}</script></main>`;
      if (scenario === "slow") setTimeout(() => res.end(html), 200); else res.end(html);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const tenant = { ...profile, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, uiFailures: [{ selector: "[data-app-error]", code: "app_error" as const }] };
    try {
      const result = await replay({ runId: "runtime", artifact: cap, inputs: { memberId: "12345" }, tenant,
        createSurface: artifact => new WebSurface(artifact, tenant),
        evidence: { append: async event => { events.push(event.code); }, diagnostic: async () => "diagnostic.json" } });
      if (scenario === "validation") {
        assert.equal(result.status, "business_outcome");
        if (result.status === "business_outcome") assert.equal(result.code, "validation_rejected");
      } else if (scenario === "slow" || scenario === "known_alert") {
        assert.equal(result.status, "success", JSON.stringify(result));
        if (scenario === "known_alert") assert.ok(events.includes("known_alert_dismissed"));
      } else {
        assert.equal(result.status, "failure");
        if (result.status === "failure") assert.equal(result.code, { permission: "permission_denied", server_error: "app_error", ui_error: "app_error", unknown_confirm: "unexpected_dialog", repeated_alert: "recovery_exhausted" }[scenario]);
      }
      assert.equal(JSON.stringify(events).includes("Sensitive"), false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}

test("safe observation retry is bounded and reports exhaustion without repeating writes", async () => {
  const cap = structuredClone(base);
  cap.steps = [{ id: "wait", description: "Wait for control", action: "wait", risk: "read_only", timeoutMs: 100,
    preconditions: [], postconditions: [{ kind: "visible", target: "balance" }], until: { kind: "visible", target: "balance" }, retry: { maxAttempts: 2, on: ["transient_timeout"], repeatSafe: true } }];
  cap.policy.allowedActions.push("wait"); cap.outcomes = [];
  let attempts = 0;
  const surface: SurfaceAdapter = { features: ["structured_targets"], start: async () => {}, close: async () => {},
    act: async () => { attempts++; throw new RunError("timeout", "Delayed control"); }, matches: async () => true, read: async () => "",
    diagnostics: async () => ({ surface: "web", sessionOpen: true, controlCount: 0 }) };
  const result = await replay({ runId: "retry", artifact: cap, inputs: { memberId: "12345" }, tenant: profile, createSurface: () => surface,
    evidence: { append: async () => {}, diagnostic: async () => "diagnostic.json" } });
  assert.equal(attempts, 2); assert.equal(result.status, "failure");
  if (result.status === "failure") { assert.equal(result.code, "recovery_exhausted"); assert.equal(result.retries.length, 1); }
});

test("one artifact runs on a differently branded tenant using a reviewed target override", async () => {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    const url = new URL(req.url ?? "/", "http://localhost");
    let html = searchPage();
    if (url.pathname === "/members") html = searchPage("", searchResult(findMember("12345")!));
    else if (url.pathname === "/members/12345") html = detailPage(findMember("12345")!);
    else if (url.pathname === "/styles.css") { res.setHeader("Content-Type", "text/css"); res.end(""); return; }
    res.end(html.replaceAll("Northstar", "Harbor Credit Union").replaceAll("Search members", "Find member"));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const tenant = { ...profile, id: "harbor", origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    reviewedControls: tenantProfileSchema.parse(JSON.parse(readFileSync("config/tenants/cedar.json", "utf8"))).reviewedControls,
    versionSelector: "[data-app-version]", targetOverrides: { searchButton: { ...base.targets.searchButton!,
      strategies: [{ kind: "role", role: "button", name: "Find member", exact: true }] } } };
  try {
    const result = await replay({ runId: "tenant-variant", artifact: base, inputs: { memberId: "12345" }, tenant,
      createSurface: (cap, config) => new WebSurface(cap, config), evidence: { append: async () => {}, diagnostic: async () => "diagnostic.json" } });
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.equal(base.targets.searchButton!.strategies[0]!.kind, "role");
    assert.equal(JSON.stringify(base.targets.searchButton).includes("Find member"), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("live version drift stops before typing or clicking even when configured version matches artifact", async () => {
  for (const marker of ['<span data-app-version>9.0.0</span>', '', '<span data-app-version>0.1.0</span><span data-app-version>0.1.0</span>']) {
    const server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(`<main>${marker}<label>Member ID<input></label></main>`); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const events: string[] = [];
    const tenant = { ...profile, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, versionSelector: "[data-app-version]" };
    try {
      const result = await replay({ runId: "drift", artifact: base, inputs: { memberId: "12345" }, tenant,
        createSurface: (cap, config) => new WebSurface(cap, config), evidence: { append: async event => { events.push(event.code); }, diagnostic: async () => "diagnostic.json" } });
      assert.equal(result.status, "failure");
      if (result.status === "failure") assert.equal(result.code, "incompatible_surface");
      assert.equal(events.includes("type"), false); assert.equal(events.includes("click"), false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});
