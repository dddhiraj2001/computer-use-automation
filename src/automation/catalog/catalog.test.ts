import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CapabilityCatalog } from "./catalog.js";
import { LocalAuthorization } from "./authorization.js";
import { RunLedger } from "./run-ledger.js";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { trackedRun } from "./tracked-run.js";

test("operator CLI tracking records normal/error outcomes and refuses unresolved work before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "tracked-test-"));
  const ledger = new RunLedger(root);
  const record = { runId: "replay", tenant: "northstar", capability: "lookup", version: "1.0.0" };
  assert.equal(await trackedRun(record, async () => "result", () => "success", ledger), "result");
  await assert.rejects(trackedRun({ ...record, runId: "discovery" }, async () => { throw new Error("stopped"); }, () => "success", ledger), /stopped/);
  assert.equal((await ledger.inspect()).filter(run => run.state === "completed").length, 2);
  await ledger.start({ ...record, runId: "interrupted" });
  let acted = false;
  await assert.rejects(trackedRun({ ...record, runId: "blocked" }, async () => { acted = true; }, () => "success", ledger), /Reconciliation/);
  assert.equal(acted, false);
});

test("retention previews and archives only old completed records, preserving unresolved work", async () => {
  const root = await mkdtemp(join(tmpdir(), "retention-test-"));
  const ledger = new RunLedger(root);
  for (const runId of ["old", "recent", "unresolved"]) await ledger.start({ runId, tenant: "northstar", capability: "lookup", version: "1.0.0" });
  await ledger.complete("old", "success"); await ledger.complete("recent", "success");
  await writeFile(join(root, "old.completed.json"), JSON.stringify({ status: "success", completedAt: "2020-01-01T00:00:00.000Z" }));
  const evidenceRoot = join(root, "runtime");
  await mkdir(join(evidenceRoot, "northstar", "old"), { recursive: true });
  await writeFile(join(evidenceRoot, "northstar", "old", "events.redacted.jsonl"), "safe event");
  assert.deepEqual(await ledger.archiveCompleted(30), ["old"]);
  assert.equal((await ledger.inspect()).length, 3);
  assert.deepEqual(await ledger.archiveCompleted(30, true, [evidenceRoot]), ["old"]);
  assert.equal(await readFile(join(root, "archive", "old", "evidence-0", "events.redacted.jsonl"), "utf8"), "safe event");
  assert.ok(await readFile(join(root, "archive", "old", "started.json"), "utf8"));
  assert.equal((await ledger.inspect()).find(run => run.runId === "unresolved")!.state, "indeterminate");
  await assert.rejects(ledger.archiveCompleted(0), /at least 30/);
});

test("guardian closes its owned Chromium after runner SIGKILL", { timeout: 30000 }, async () => {
  const moduleUrl = new URL("../replay/owned-browser.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {launchOwnedBrowser} from ${JSON.stringify(moduleUrl)}; const owned=await launchOwnedBrowser(true); process.stdout.write(String(owned.browserPid)); setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const [chunk] = await Promise.race([once(child.stdout!, "data"), once(child, "exit").then(() => { throw new Error("Runner exited before browser launch"); })]);
    const browserPid = Number(String(chunk)); assert.ok(Number.isInteger(browserPid) && browserPid > 0);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const end = Date.now() + 10000;
    let gone = false;
    while (Date.now() < end) {
      try { process.kill(browserPid, 0); }
      catch (error) { gone = error instanceof Error && "code" in error && error.code === "ESRCH"; }
      if (gone) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(gone, true, "Owned browser must exit after runner death");
  } finally { child.kill("SIGKILL"); }
});

test("ledger survives killed process and never treats incomplete work as completed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ledger-test-"));
  const moduleUrl = new URL("./run-ledger.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {RunLedger} from ${JSON.stringify(moduleUrl)}; const ledger=new RunLedger(${JSON.stringify(root)}); await ledger.exclusively(async()=>{await ledger.start({runId:"interrupted",tenant:"northstar",capability:"lookup",version:"1.0.0"}); process.stdout.write("ready"); await new Promise(()=>setInterval(()=>{},1000));});`], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await Promise.race([once(child.stdout!, "data"), once(child, "exit").then(() => { throw new Error("Child exited before ledger write"); })]);
    await assert.rejects(new RunLedger(root).exclusively(async () => {}), /ownership unavailable/);
    const accessPolicy = JSON.parse(readFileSync("config/catalog-access.json", "utf8"));
    const operator = new LocalAuthorization(accessPolicy, "local-operator");
    const token = (await new RunLedger(root).owner()).token;
    await assert.rejects(new RunLedger(root).abandonInterrupted(token, operator, true), /live/);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const ledger = new RunLedger(root);
    await assert.rejects(ledger.exclusively(async () => {}), /ownership unavailable/);
    assert.deepEqual(await ledger.inspect(), [{ runId: "interrupted", state: "indeterminate" }]);
    await assert.rejects(ledger.start({ runId: "interrupted", tenant: "northstar", capability: "lookup", version: "1.0.0" }));
    await assert.rejects(ledger.abandonInterrupted(token, operator, false), /confirmation/);
    await assert.rejects(ledger.abandonInterrupted(token, new LocalAuthorization(accessPolicy, "local-demo"), true), /not authorized/);
    await assert.rejects(ledger.abandonInterrupted("stale-token", operator, true), /changed/);
    await ledger.abandonInterrupted(token, operator, true);
    assert.deepEqual(await ledger.inspect(), [{ runId: "interrupted", state: "abandoned" }]);
    assert.equal(await ledger.exclusively(async () => "new work permitted"), "new work permitted");
    await ledger.start({ runId: "normal", tenant: "northstar", capability: "lookup", version: "1.0.0" });
    await ledger.complete("normal", "success");
    assert.equal((await ledger.inspect()).find(run => run.runId === "normal")!.state, "completed");
    const stored = JSON.parse(await readFile(join(root, "normal.started.json"), "utf8"));
    assert.deepEqual(Object.keys(stored).sort(), ["capability", "runId", "startedAt", "tenant", "version"]);
  } finally { child.kill("SIGKILL"); }
});

test("filesystem ownership serializes instances and releases after ordinary errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "ownership-test-"));
  const first = new RunLedger(root), second = new RunLedger(root);
  await first.exclusively(async () => {
    await assert.rejects(second.exclusively(async () => {}), /ownership unavailable/);
  });
  await assert.rejects(first.exclusively(async () => { throw new Error("work failed"); }), /work failed/);
  assert.equal(await second.exclusively(async () => "acquired"), "acquired");
});

test("catalog bounds concurrency and releases slot after executor failure", async () => {
  const artifact = JSON.parse(readFileSync("examples/member-balance.capability.json", "utf8"));
  const tenant = JSON.parse(readFileSync("config/tenants/northstar.json", "utf8"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const catalog = new CapabilityCatalog([artifact], tenant, async () => { await gate; throw new Error("executor failed"); },
    new LocalAuthorization(JSON.parse(readFileSync("config/catalog-access.json", "utf8")), "local-demo"));
  const call = { name: "member.read-savings-balance", version: "1.0.0", args: { memberId: "12345" } };
  const first = catalog.invoke(call);
  assert.deepEqual(await catalog.invoke(call), { status: "rejected", code: "busy" });
  release(); await assert.rejects(first, /executor failed/);
  await assert.rejects(catalog.invoke(call), /executor failed/);
});

test("catalog isolates trusted tenant and validates named calls before execution", async () => {
  const artifact = JSON.parse(readFileSync("examples/member-balance.capability.json", "utf8"));
  const tenant = JSON.parse(readFileSync("config/tenants/northstar.json", "utf8"));
  let calls = 0;
  const catalog = new CapabilityCatalog([artifact], tenant, async (cap, profile, inputs) => {
    calls++;
    assert.equal(profile.id, "northstar"); assert.equal(inputs.memberId, "01234");
    return { runId: "test", capabilityId: cap.capability.id, capabilityVersion: cap.capability.version,
      status: "success", checkpointVerified: true, outputs: { balance: "1.00" } };
  }, new LocalAuthorization(JSON.parse(readFileSync("config/catalog-access.json", "utf8")), "local-demo"));
  tenant.id = "attacker";
  const call = { name: "member.read-savings-balance", version: "1.0.0", args: { memberId: "01234" } };
  assert.equal((await catalog.invoke({ ...call, tenant: "attacker" })).status, "rejected");
  assert.equal((await catalog.invoke({ ...call, name: "unknown" })).status, "rejected");
  assert.equal((await catalog.invoke({ ...call, args: { memberId: 1234 } })).status, "rejected");
  assert.equal(calls, 0);
  catalog.list()[0]!.inputs.memberId!.description = "mutated";
  assert.notEqual(catalog.list()[0]!.inputs.memberId!.description, "mutated");
  assert.equal((await catalog.invoke(call)).status, "success"); assert.equal(calls, 1);
  assert.throws(() => new CapabilityCatalog([artifact, artifact], tenant, async () => { throw new Error(); }), /Duplicate/);
});

test("authorization denies missing/unknown callers, wrong tenant/version and identity injection before execution", async () => {
  const artifact = JSON.parse(readFileSync("examples/member-balance.capability.json", "utf8"));
  const tenant = JSON.parse(readFileSync("config/tenants/northstar.json", "utf8"));
  const policy = JSON.parse(readFileSync("config/catalog-access.json", "utf8"));
  let calls = 0;
  for (const caller of [undefined, "unknown", "local-demo"]) {
    const access = new LocalAuthorization(policy, caller);
    for (const tenantId of ["northstar", "cedar"]) {
      const catalog = new CapabilityCatalog([artifact], { ...tenant, id: tenantId }, async () => { calls++; throw new Error("must not execute"); }, access);
      const call = { name: "member.read-savings-balance", version: "1.0.0", args: { memberId: "12345" } };
      if (caller !== "local-demo" || tenantId !== "northstar") {
        assert.deepEqual(catalog.list(), []);
        assert.deepEqual(await catalog.invoke(call), { status: "rejected", code: "forbidden" });
      }
      assert.equal((await catalog.invoke({ ...call, callerId: "local-demo" })).status, "rejected");
      assert.deepEqual(await catalog.invoke({ ...call, version: "2.0.0" }), { status: "rejected", code: "forbidden" });
    }
  }
  assert.equal(calls, 0);
  const copied = new LocalAuthorization(policy, "local-demo");
  policy.callers[0].grants.push({ tenant: "cedar", capability: "member.read-savings-balance", version: "1.0.0" });
  assert.equal(copied.permits("cedar", "member.read-savings-balance", "1.0.0"), false);
  assert.throws(() => new LocalAuthorization({ callers: [policy.callers[0], policy.callers[0]] }, "local-demo"), /Duplicate/);
});
