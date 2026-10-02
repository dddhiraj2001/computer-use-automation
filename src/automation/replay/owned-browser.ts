import { fork } from "node:child_process";
import { chromium, type Browser } from "playwright";
import { z } from "zod";

export async function launchOwnedBrowser(headless: boolean): Promise<{ browser: Browser; browserPid: number; close: () => Promise<void> }> {
  const source = import.meta.url.endsWith(".ts");
  const guardian = fork(new URL(source ? "./browser-guardian.ts" : "./browser-guardian.js", import.meta.url), [], {
    execArgv: source ? ["--import", "tsx"] : [], stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "PLAYWRIGHT_BROWSERS_PATH", "SystemRoot"].flatMap(key =>
      process.env[key] === undefined ? [] : [[key, process.env[key]!]])) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await new Promise<{ endpoint: string; browserPid: number }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Browser startup timed out.")), 20000);
      guardian.once("error", () => reject(new Error("Browser guardian failed.")));
      guardian.once("exit", () => reject(new Error("Browser guardian exited.")));
      guardian.once("message", message => {
        const parsed = z.object({ endpoint: z.string().url(), browserPid: z.number().int().positive() }).strict().safeParse(message);
        if (!parsed.success) reject(new Error("Browser startup failed.")); else resolve(parsed.data);
      });
      guardian.send({ headless });
    });
    clearTimeout(timer);
    const browser = await chromium.connect(ready.endpoint, { timeout: 5000 });
    return { browser, browserPid: ready.browserPid, close: async () => {
      try { await browser.close(); }
      finally { if (guardian.connected) guardian.disconnect(); }
    } };
  } catch (error) {
    if (guardian.connected) guardian.disconnect();
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}
