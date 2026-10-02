import { createServer } from "node:http";
import { findMember } from "./members.js";
import { detailPage, layout, searchPage, searchResult } from "./views.js";
import { styles } from "./styles.js";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'");
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end(layout("Method not allowed", "<h1>Method not allowed</h1>"));
    return;
  }
  if (url.pathname === "/styles.css") {
    response.setHeader("Content-Type", "text/css; charset=utf-8");
    response.end(styles);
    return;
  }
  if (url.pathname === "/runtime.js") {
    response.setHeader("Content-Type", "application/javascript");
    response.end(process.env.DEMO_RUNTIME === "known_dialog" ? 'alert("Demo informational notice");' : 'confirm("Unexpected demo confirmation");');
    return;
  }
  if (url.pathname === "/health") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: "ok", application: "demo-bank" }));
    return;
  }
  if (url.pathname === "/") {
    response.end(searchPage());
    return;
  }
  if (url.pathname === "/members") {
    const id = url.searchParams.get("memberId") ?? "";
    if (!/^[0-9]{5}$/.test(id)) {
      response.statusCode = 400;
      response.end(searchPage("", '<p class="notice" role="alert">Enter a valid five-digit member ID.</p>'));
      return;
    }
    const member = findMember(id);
    if (process.env.DEMO_RUNTIME === "validation") {
      response.statusCode = 422;
      response.end(searchPage(id, '<p role="alert">Lookup rejected by application validation.</p>'));
      return;
    }
    if (["permission", "app_error"].includes(process.env.DEMO_RUNTIME ?? "")) {
      response.statusCode = process.env.DEMO_RUNTIME === "permission" ? 403 : 503;
      response.end(layout("Unavailable", "<h1>Requested operation unavailable</h1>"));
      return;
    }
    if (process.env.DEMO_HANDOFF === "true" && member && url.searchParams.get("reviewed") !== "yes") {
      response.end(layout("Operator check", `<h1>Operator check required</h1><p>The lookup is paused for a synthetic operator check.</p><form action="/members" method="get"><input type="hidden" name="memberId" value="${id}"><input type="hidden" name="reviewed" value="yes"><button type="submit">Continue lookup</button></form>`));
      return;
    }
    const content = searchPage(id, member ? searchResult(member) : '<p class="notice" role="status">Member not found. Check the member ID and try again.</p>');
    if (process.env.DEMO_RUNTIME === "slow") { setTimeout(() => response.end(content), 750); return; }
    response.end(["known_dialog", "unknown_dialog"].includes(process.env.DEMO_RUNTIME ?? "") ? content.replace("</body>", '<script src="/runtime.js"></script></body>') : content);
    return;
  }
  const match = /^\/members\/([0-9]{5})$/.exec(url.pathname);
  const member = match?.[1] ? findMember(match[1]) : undefined;
  if (member) {
    if (process.env.DEMO_SESSION_EXPIRY === "true") {
      const restored = request.headers.cookie?.split("; ").includes("demo_session=restored");
      if (!restored && url.searchParams.get("restore") !== "yes") {
        response.statusCode = 401;
        response.end(layout("Session expired", `<h1>Your demo login has timed out</h1><p>The automation cannot read the account until access is restored. Your lookup has not been completed.</p><ol><li>Wait until the terminal says Human control active.</li><li>Click Restore demo session below. This simulates signing in; do not enter real credentials.</li><li>Return to the terminal, type resume, and press Enter.</li></ol><p>The automation will check access and the requested member before returning a balance. To stop instead, type abort in the terminal.</p><form method="get" action="${url.pathname}"><input type="hidden" name="restore" value="yes"><button type="submit">Restore demo session</button></form>`));
        return;
      }
      if (!restored) response.setHeader("Set-Cookie", "demo_session=restored; HttpOnly; SameSite=Strict; Path=/");
      response.end(detailPage(member).replace("</main>", '<p data-session-state="authenticated" data-permission="member-read">Member read access restored</p></main>'));
      return;
    }
    response.end(detailPage(member));
    return;
  }
  response.statusCode = 404;
  response.end(layout("Not found", '<h1>Page not found</h1><p><a href="/">Return to member lookup</a></p>'));
});

server.on("error", (error) => {
  console.error(`Unable to start demo bank: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Demo bank: http://127.0.0.1:${port}`);
  console.log("Synthetic data only. Session restoration fixtures are not real authentication.");
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close());
}
