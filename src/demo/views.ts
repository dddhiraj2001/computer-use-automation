import type { Member } from "./members.js";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]!);
}

export function layout(title: string, content: string): string {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | Northstar Demo Bank</title><link rel="stylesheet" href="/styles.css"></head>
<body><header><a class="brand" href="/">N<span>Northstar<small>Member services</small></span></a><span class="badge">SANDBOX · SYNTHETIC DATA</span></header>
<div class="shell"><nav aria-label="Main navigation"><p class="nav-label">WORKSPACE</p><a href="/">Member lookup</a><div class="operator">Local operator<br><small>Training environment</small></div></nav>
<main><p class="eyebrow">MEMBER SERVICES / ${escapeHtml(title.toUpperCase())}</p>${content}</main></div>
<footer>Northstar is a fictional institution. All records are synthetic. No real banking transactions are available. App version: <span data-app-version>0.1.0</span></footer></body></html>`;
  // Demo deployment variant only; never used to select an automation tenant.
  return process.env.DEMO_VARIANT === "cedar" ? html.replaceAll("Northstar", "Cedar").replace("Search members</button>", "Find member</button>") : html;
}

export function searchPage(query = "", result = ""): string {
  return layout("Member lookup", `<h1>Find a member</h1><p class="intro">Search the member directory to view account details and savings balances.</p>
<section class="card"><h2>Member search</h2><form action="/members" method="get"><label for="memberId">Member ID</label><div class="search-row"><input id="memberId" name="memberId" value="${escapeHtml(query)}" placeholder="Enter a 5-digit ID" inputmode="numeric" maxlength="5" pattern="[0-9]{5}" required><button type="submit">Search members</button></div><p class="hint">Enter the complete five-digit member number.</p></form>${result}</section>
<aside class="fixtures"><h2>Demo records</h2><p>Try <code>12345</code>, <code>23456</code>, or <code>34567</code>. Use <code>99999</code> to see a member-not-found result.</p></aside>`);
}

export function searchResult(member: Member): string {
  return `<section class="result"><h3>1 member found</h3><table><caption class="sr-only">Matching members</caption><thead><tr><th>Member ID</th><th>Name</th><th>Action</th></tr></thead><tbody><tr><td>${member.id}</td><td>${escapeHtml(member.name)}</td><td><a href="/members/${member.id}">View account</a></td></tr></tbody></table></section>`;
}

export function detailPage(member: Member): string {
  const balance = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(member.savingsCents / 100);
  return layout("Account details", `<a class="back" href="/">← Back to member lookup</a><h1>${escapeHtml(member.name)}</h1><p class="intro">Member ID ${member.id} <span class="active">Active</span></p>
<section class="card"><h2>Account overview</h2><table><caption>Savings account</caption><tbody><tr><th scope="row">Account type</th><td>Primary savings</td></tr><tr><th scope="row">Current balance</th><td class="balance">${balance}</td></tr><tr><th scope="row">Currency</th><td>USD</td></tr><tr><th scope="row">Status</th><td>Open</td></tr></tbody></table></section>`);
}
