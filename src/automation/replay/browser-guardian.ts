import { chromium, type BrowserServer } from "playwright";

// Owns exactly one browser child. Parent death closes that browser, never a PID found by scanning.
let server: BrowserServer | undefined;
let stopping = false;
async function stop() {
  stopping = true;
  if (server) {
    const owned = server;
    const deadline = setTimeout(() => { void owned.kill().catch(() => {}); }, 5000);
    try { await owned.close(); } catch { try { await owned.kill(); } catch { /* Parent records interruption. */ } }
    finally { clearTimeout(deadline); }
  }
  if (process.connected) process.disconnect();
}
process.on("disconnect", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
process.once("message", async (message: unknown) => {
  if (!message || typeof message !== "object" || !("headless" in message) || typeof message.headless !== "boolean") return stop();
  try {
    server = await chromium.launchServer({ headless: message.headless, timeout: 15000 });
    if (stopping || !process.connected) return stop();
    process.send?.({ endpoint: server.wsEndpoint(), browserPid: server.process().pid });
  } catch { process.send?.({ failed: true }); await stop(); }
});
