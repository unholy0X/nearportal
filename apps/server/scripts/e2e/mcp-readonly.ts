// Real deployed-server check after a human approves a READ-ONLY CLI login.
// No bounty mutation, claim, merge or payment. Revokes this test credential afterward.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { credentials } from "../../mcp/credentials.ts";
import { NearPortalClient } from "../../mcp/client.ts";

const origin = process.env.NEARPORTAL_URL ?? "https://nearportal.com";
const token = credentials.token(origin);
assert.ok(token, "First run nearportal-mcp login --scopes read and approve it in your browser");
assert.deepEqual(credentials.account(origin)!.scopes, ["read"], "Use a dedicated read-only test credential");
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("mcp/nearportal-mcp.mjs"), "serve", "--server", origin], cwd: tmpdir(), stderr: "pipe" });
let stderr = "";
transport.stderr?.on("data", (b) => { stderr += b; });
const client = new Client({ name: "NearPortal VPS verification", version: "1.0.0" });
const http = new NearPortalClient(origin, () => token);
const report: Record<string, unknown> = { at: new Date().toISOString(), origin, transport: "stdio", testedAgainstRealGitHubLogin: true };
try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 13);
  report.tools = listed.tools.map((t) => t.name);
  const call = async (name: string, args = {}) => {
    const r = (await client.callTool({ name, arguments: args })).structuredContent as any;
    assert.equal(r.ok, true, name + ": " + r.error?.code);
    assert.ok(r.requestId);
    return r.data;
  };
  const account = await call("account_status");
  assert.deepEqual(account.credential.scopes, ["read"]);
  const expectUsdc = process.env.EXPECT_USDC_READY === "1";
  assert.equal(account.capabilities.fixedDeadlineUsdc, expectUsdc);
  assert.equal(account.environment.realFunds, false);
  report.account = { login: account.account.login, scopes: account.credential.scopes, verifiedWallets: account.wallets.length, fixedDeadlineUsdc: expectUsdc };
  const search = await call("list_bounties", { limit: 5 });
  report.search = { total: search.total, returned: search.bounties.length };
  const activity = await call("list_my_activity", { kind: "all" });
  report.activityCounts = activity.counts;
  await http.call("POST", "/api/agent/v1/logout", { body: {}, mutation: true });
  const denied = (await client.callTool({ name: "account_status", arguments: {} })).structuredContent as any;
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "credential_revoked");
  report.revocation = { immediate: true, code: denied.error.code };
  assert.ok(!stderr.includes(token), "Client stderr must never contain the bearer token");
  report.passed = true;
} finally {
  // Revoke even when a read check failed, without touching a concurrently replaced credential.
  await http.call("POST", "/api/agent/v1/logout", { body: {}, mutation: true }).catch(() => {});
  if (credentials.token(origin) === token) credentials.remove(origin);
  await client.close();
  await transport.close();
}
const out = process.argv[2];
if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
