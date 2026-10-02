import { errors, type Browser, type Page, type Locator, type FrameLocator, type Frame } from "playwright";
import { launchOwnedBrowser } from "./owned-browser.js";
import type { Capability } from "../contracts/capability.js";
import type { ObservedControl } from "../discovery/ports.js";
import { destinationAllowed, routeAllowed, type TenantProfile } from "./policy.js";
import { RunError, type SurfaceAdapter, type Step, type Condition, type Values } from "./ports.js";
import { diagnosticSchema, manualActionSchema, safeTagSchema, type ManualAction, type SurfaceDiagnostic } from "./diagnostic-schema.js";

export class WebSurface implements SurfaceAdapter {
  get features(): string[] { return ["structured_targets", "frames", ...(this.headless ? [] : ["manual_control"])]; }
  private browser: Browser | undefined;
  private closeOwned: (() => Promise<void>) | undefined;
  protected page: Page | undefined;
  private fault: RunError | undefined;
  private owner: "automation" | "human" | "resuming" = "automation";
  private recordManual: ((code: string, action?: ManualAction) => Promise<void>) | undefined;
  private manualWrites: Promise<void> = Promise.resolve();
  private documentStatuses = new Map<Frame, number>();
  private expiredFrames = new Set<Frame>();
  private dialogWork: Promise<void> = Promise.resolve();
  private recoveredAlerts = 0;
  private recoveries: string[] = [];
  constructor(private readonly capability: Capability, private readonly tenant: TenantProfile, private readonly headless = true) {}
  async start(): Promise<void> {
    const owned = await launchOwnedBrowser(this.headless);
    this.browser = owned.browser;
    this.closeOwned = owned.close;
    const context = await this.browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
      // Human-operated windows follow their native size; CI retains deterministic geometry.
      viewport: this.headless ? { width: 1280, height: 720 } : null
    });
    await context.exposeBinding("recordManualEvent", (_source, kind: unknown, detail: unknown) => {
      if (this.owner !== "human" || !this.recordManual || !["click", "input", "change", "submit"].includes(String(kind))) return;
      const record = this.recordManual;
      const parsed = manualActionSchema.safeParse(detail);
      if (!parsed.success) { this.fault = new RunError("internal_error", "Manual action metadata was rejected."); return; }
      this.manualWrites = this.manualWrites.then(() => record(`human_${String(kind)}`, parsed.data)).catch(() => {
        this.fault = new RunError("internal_error", "Human action audit failed; resume is prohibited.");
      });
      return this.manualWrites;
    });
    await context.addInitScript(tags => {
      for (const kind of ["click", "input", "change", "submit"]) {
        document.addEventListener(kind, event => {
          if (!event.isTrusted) return;
          const node = event.target instanceof Element ? event.target.closest("input,button,a,select,textarea,form") ?? event.target : null;
          if (!node) return;
          const rect = node.getBoundingClientRect();
          const tag = node.tagName.toLowerCase();
          const type = node instanceof HTMLInputElement ? node.type : "none";
          const detail = { tag: tags.some(allowed => allowed === tag) ? tag : "other",
            controlType: ["text", "password", "checkbox", "radio", "submit", "button", "hidden", "none"].includes(type) ? type : "other",
            box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
          const bridge = (window as unknown as { recordManualEvent: (kind: string, detail: unknown) => Promise<void> }).recordManualEvent;
          void bridge(kind, detail).catch(() => undefined);
        }, true);
      }
    }, safeTagSchema.options);
    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      // Every HTTP request is checked, including each redirect destination.
      const allowed = ["GET", "HEAD"].includes(request.method()) &&
        (request.isNavigationRequest() ? destinationAllowed(url.href, this.tenant, this.capability) :
          url.origin === this.tenant.origin && routeAllowed(url.pathname, this.tenant.resourcePaths));
      if (!allowed) {
        this.fault = new RunError("policy_denied", "A request destination or method was outside trusted policy.");
        await route.abort();
      } else {
        try {
          // Fetch without following redirects: routing hooks alone do not guard every redirect hop.
          const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 10000 });
          if (response.status() >= 300 && response.status() < 400) {
            this.fault = new RunError("policy_denied", "Redirect requires explicit review; no redirect destination was contacted.");
            await route.abort();
          } else await route.fulfill({ response });
        } catch {
          this.fault ??= new RunError("app_error", "Allowed application request failed.");
          await route.abort().catch(() => undefined);
        }
      }
    });
    await context.routeWebSocket("**/*", socket => { this.fault = new RunError("policy_denied", "WebSockets are not permitted by this adapter."); socket.close(); });
    this.page = await context.newPage();
    this.page.setDefaultTimeout(1000);
    this.page.on("dialog", dialog => {
      const known = dialog.type() === "alert" && this.tenant.informationalAlerts.includes(dialog.message());
      if (!known) this.fault = new RunError("unexpected_dialog", "Unrecognized dialog stopped execution; no confirmation was accepted.");
      else if (++this.recoveredAlerts > 1) this.fault = new RunError("recovery_exhausted", "Informational dialog recovery budget exhausted.");
      this.dialogWork = dialog.dismiss().then(() => {
        if (known && !this.fault) this.recoveries.push("known_alert_dismissed");
      }).catch(() => { this.fault = new RunError("app_error", "Dialog could not be dismissed safely."); });
    });
    this.page.on("crash", () => { this.fault = new RunError("app_error", "Browser page crashed; session cannot safely continue."); });
    this.page.on("response", response => {
      if (response.request().isNavigationRequest()) {
        const frame = response.frame();
        this.documentStatuses.set(frame, response.status());
        if (response.status() === 401) {
          this.expiredFrames.add(frame);
          this.fault ??= new RunError("session_expired", "Application session expired.");
        }
        if (!this.fault || this.fault.code === "session_expired") {
          if (response.status() === 403) this.fault = new RunError("permission_denied", "Application denied permission.");
          if (response.status() >= 500) this.fault = new RunError("app_error", "Application returned a server error.");
        }
      }
    });
    context.on("page", page => {
      if (page !== this.page) {
        this.fault = new RunError("policy_denied", "Unexpected additional browser window.");
        void page.close().catch(() => undefined);
      }
    });
  }
  private checkedPage(allowExpired = false): Page {
    if (this.fault && !(allowExpired && this.fault.code === "session_expired")) throw this.fault;
    if (!this.page || this.page.isClosed()) throw new RunError("app_error", "Browser session unavailable.");
    const url = this.page.url();
    if (url !== "about:blank" && !destinationAllowed(url, this.tenant, this.capability)) throw new RunError("policy_denied", "Page left the permitted application routes.");
    return this.page;
  }
  private async locate(id: string): Promise<Locator | undefined> {
    const page = await this.healthyPage();
    const target = this.capability.targets[id];
    if (!target) throw new RunError("target_missing", "Unknown target reference.");
    let scope: Page | FrameLocator = page;
    for (const frame of target.framePath) scope = scope.frameLocator(frame);
    for (const strategy of target.strategies) {
      let locator: Locator;
      if (strategy.kind === "role") {
        type Role = Parameters<Page["getByRole"]>[0];
        locator = scope.getByRole(strategy.role as Role, { name: strategy.name, exact: true });
      } else if (strategy.kind === "label") locator = scope.getByLabel(strategy.text, { exact: true });
      else if (strategy.kind === "text") locator = scope.getByText(strategy.text, { exact: true });
      else locator = scope.locator(strategy.selector);
      const count = await locator.count();
      if (count > 1) throw new RunError("target_ambiguous", "Target strategy matched multiple controls.");
      if (count === 1) return locator;
    }
    return undefined;
  }
  async matches(condition: Condition, inputs: Values): Promise<boolean> {
    const locator = await this.locate(condition.target);
    if (!locator || !await locator.isVisible()) return false;
    if (condition.kind === "visible") return true;
    const value = (await locator.innerText({ timeout: 1000 })).trim();
    return condition.kind === "text_equals" ? value === condition.value : value.includes(String(inputs[condition.input]));
  }
  async act(step: Step, inputs: Values): Promise<void> {
    if (this.owner !== "automation") throw new RunError("policy_denied", "Automation does not own this session.");
    try {
      const page = await this.healthyPage();
      if (step.action === "navigate") {
        const url = new URL(step.path, this.tenant.origin).href;
        if (!destinationAllowed(url, this.tenant, this.capability)) throw new RunError("policy_denied", "Navigation denied before execution.");
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: step.timeoutMs });
      } else {
        const end = Date.now() + step.timeoutMs;
        while (true) {
          if (step.action === "wait") {
            if (await this.matches(step.until, inputs)) break;
          } else {
            const locator = await this.locate(step.target);
            if (locator) {
              const timeout = Math.max(1, end - Date.now());
              if (step.action === "type") await locator.fill(String(inputs[step.input]), { timeout });
              else await locator.click({ timeout });
              break;
            }
          }
          if (Date.now() >= end) throw new RunError("timeout", "Control did not become available before the deadline.");
          await new Promise<void>(resolve => setTimeout(resolve, 50));
        }
      }
      await this.healthyPage();
    } catch (error) {
      if (this.fault) throw this.fault;
      if (error instanceof RunError) throw error;
      if (error instanceof errors.TimeoutError) throw new RunError("timeout", "Browser operation exceeded its deadline.");
      throw new RunError("app_error", "Browser action failed; raw exception data was omitted.");
    }
  }
  async read(target: string): Promise<string> {
    const locator = await this.locate(target);
    if (!locator) throw new RunError("target_missing", "Extraction control is absent.");
    const value = await locator.innerText({ timeout: 1000 });
    await this.healthyPage();
    return value;
  }
  /** Discovery-only observation; do not persist the returned page text. */
  async observe(): Promise<ObservedControl[]> {
    const page = await this.healthyPage();
    const elements = await page.locator("input:not([type=password]),button,a,table tr:has(th) td,main > p.intro").evaluateAll(nodes => nodes.map(node => {
      const element = node as HTMLElement;
      const input = node as HTMLInputElement;
      return { tag: node.tagName.toLowerCase(), text: (element.innerText ?? "").trim().slice(0,300),
        label: input.labels?.[0]?.textContent?.trim() ?? "", heading: node.closest("tr")?.querySelector("th")?.textContent?.trim() ?? "",
        visible: !!element.getClientRects().length, filled: node.tagName === "INPUT" && input.value.length > 0 };
    }));
    const targets: ObservedControl[] = [];
    for (const element of elements.filter(item => item.visible)) {
      let strategy: Capability["targets"][string]["strategies"][number];
      if (element.tag === "input" && element.label) strategy = { kind: "label", text: element.label, exact: true };
      else if ((element.tag === "button" || element.tag === "a") && element.text) strategy = { kind: "role", role: element.tag === "a" ? "link" : "button", name: element.text, exact: true };
      else if (element.tag === "td" && element.heading) strategy = { kind: "css", selector: `table tr:has(th:text-is(${JSON.stringify(element.heading)})) td` };
      else if (element.tag === "p") strategy = { kind: "css", selector: "main > p.intro" };
      else continue;
      const id = `observed${targets.length}`;
      targets.push({ id, text: element.tag === "input" ? element.label : element.text, tag: element.tag, filled: element.filled,
        target: { description: "Observed UI control", robustness: "Visible label or table heading anchor; unique match required during execution.", framePath: [], strategies: [strategy] } });
    }
    return targets;
  }
  async diagnostics(): Promise<SurfaceDiagnostic> {
    const open = !!this.page && !this.page.isClosed();
    if (!open) return { surface: "web", sessionOpen: false, controlCount: 0 };
    const snapshot = await this.page!.locator("body").evaluate((body, tags) => {
      const all = [body, ...Array.from(body.querySelectorAll("*"))].filter(node => !["SCRIPT", "STYLE", "NOSCRIPT"].includes(node.tagName));
      const selected = all.slice(0, 500);
      return { format: "structural-dom-v1" as const, truncated: all.length > selected.length, nodes: selected.map((node, index) => {
        const box = node.getBoundingClientRect();
        const tag = node.tagName.toLowerCase();
        return { index, parent: node.parentElement ? selected.indexOf(node.parentElement) : -1,
          tag: tags.some(allowed => allowed === tag) ? tag : "other", visible: !!node.getClientRects().length && getComputedStyle(node).visibility !== "hidden",
          disabled: node.matches(":disabled"), box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } };
      }) };
    }, safeTagSchema.options);
    return diagnosticSchema.parse({ surface: "web", sessionOpen: true, controlCount: await this.page!.locator("input,button,a,select").count(), snapshot });
  }
  drainRecoveries(): string[] { return this.recoveries.splice(0); }
  private async healthyPage(): Promise<Page> {
    await this.dialogWork;
    const page = this.checkedPage();
    if (this.tenant.versionSelector && page.url() !== "about:blank") {
      const version = page.locator(this.tenant.versionSelector);
      if (await version.count() !== 1 || !await version.isVisible() || (await version.innerText()).trim() !== this.tenant.appVersion) {
        throw new RunError("incompatible_surface", "Live application version is missing, ambiguous or incompatible with the trusted profile.");
      }
    }
    // All attached documents are in the same restricted session. Conservatively
    // stop on any frame error, including nested legacy frames, not only the top page.
    for (const frame of page.frames()) {
      for (const rule of this.tenant.uiFailures) {
        const markers = frame.locator(rule.selector);
        for (let index = 0; index < await markers.count(); index++) {
          if (await markers.nth(index).isVisible()) {
            if (rule.code === "session_expired") this.expiredFrames.add(frame);
            this.fault = new RunError(rule.code, "A configured application error state is visible.");
            throw this.fault;
          }
        }
      }
      for (const selector of this.tenant.operatorRequiredSelectors) {
        const markers = frame.locator(selector);
        for (let index = 0; index < await markers.count(); index++) {
          if (await markers.nth(index).isVisible()) {
            throw new RunError("operator_required", "Trusted policy requires human control at this application state.");
          }
        }
      }
    }
    this.checkedPage();
    return page;
  }
  async beginManual(record: (code: string, action?: ManualAction) => Promise<void>): Promise<void> {
    if (this.headless || this.owner !== "automation") throw new RunError("incompatible_surface", "Manual takeover requires a headed session owned by automation.");
    const page = this.checkedPage(true);
    this.recordManual = record;
    this.owner = "human";
    await page.bringToFront();
  }
  async endManual(): Promise<void> {
    if (this.owner !== "human") throw new RunError("policy_denied", "No human lease is active.");
    this.owner = "resuming";
    await this.manualWrites;
    this.recordManual = undefined;
    if (this.fault?.code === "session_expired") {
      this.checkedPage(true);
      const selector = this.tenant.sessionRecoverySelector;
      if (!selector || !this.expiredFrames.size) throw new RunError("session_expired", "Session restoration was not verified.");
      for (const frame of this.expiredFrames) {
        if (frame.isDetached() || this.documentStatuses.get(frame) !== 200) throw new RunError("session_expired", "Affected document restoration was not verified.");
        const marker = frame.locator(selector);
        if (await marker.count() !== 1 || !await marker.isVisible()) throw new RunError("session_expired", "Authenticated permission marker is missing or ambiguous.");
      }
      // Recheck after awaited DOM inspection; a concurrent policy fault must never be cleared.
      if (this.fault?.code !== "session_expired") { this.checkedPage(); }
      else { this.fault = undefined; this.expiredFrames.clear(); }
    }
    await this.healthyPage(); // Do not return ownership while an operator-only state remains.
    this.owner = "automation";
  }
  async close(): Promise<void> { await this.closeOwned?.(); }
}
