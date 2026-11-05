// Exercise the production portalRuntime composition without starting server/tasks.ts or timers.
// OAuth HTTP is stubbed; all escrow operations use the isolated SimChain.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { agentWorld, KEY, users } from "./agent-world.ts";

test("audit: production route composition connects OAuth → device token → batch → funding status", async (t) => {
  const saved = { ...process.env };
  const w = await agentWorld();
  w.clock.now = Date.now();
  let runtime: Awaited<ReturnType<typeof import("../server/portal/http.ts").portalRuntime>>;
  const server = createServer(async (req, res) => {
    try {
      if (await runtime.agent.handler(req, res)) return;
      if (await runtime.handler(req, res)) return;
      res.writeHead(404); res.end();
    } catch { res.writeHead(500); res.end(); }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await w.close(); process.env = saved;
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  Object.assign(process.env, { APP_ORIGIN: origin, ENV_FILE: "/dev/null", DATA_DIR: w.dir, PORTAL_ENCRYPTION_KEY: KEY.toString("base64"), GITHUB_USE_CLI: "0", GITHUB_OAUTH_CLIENT_ID: "audit-client", GITHUB_OAUTH_CLIENT_SECRET: "audit-secret" });
  delete process.env.PORTAL_FRONTEND_ORIGIN;
  const { portalRuntime } = await import("../server/portal/http.ts");
  runtime = await portalRuntime(w.service, { githubFor: w.portal.githubFor, write: w.portal.write });
  const oauthCalls: string[] = [];
  (runtime.auth as any).request = async (url: string, init: RequestInit) => {
    oauthCalls.push(String(url));
    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(String(init.body));
      assert.ok(body.code_verifier.length >= 43);
      return Response.json({ access_token: "audit-oauth-token", expires_in: 28_800, refresh_token: "audit-refresh-token", refresh_token_expires_in: 15_897_600 });
    }
    assert.equal(String(url), "https://api.github.com/user");
    return Response.json({ ...users.owner, avatar_url: "" });
  };
  const json = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error" });
    return { status: r.status, ...(await r.json() as any) };
  };
  const start = await json("/api/agent/device/code", { clientName: "audit-runtime", scopes: ["read", "create"], expectedLogin: users.owner!.login });
  assert.equal(start.status, 200);
  assert.equal((await fetch(start.data.verificationUriComplete)).status, 200);
  const returnTo = `/agent/connect?code=${start.data.userCode}`;
  const login = await fetch(origin + "/auth/github?returnTo=" + encodeURIComponent(returnTo), { redirect: "manual" });
  assert.equal(login.status, 302);
  const github = new URL(login.headers.get("location")!);
  assert.equal(github.origin, "https://github.com");
  assert.equal(github.searchParams.get("code_challenge_method"), "S256");
  const callback = `/auth/github/callback?state=${github.searchParams.get("state")}&code=audit`;
  const result = await fetch(origin + callback, { redirect: "manual", headers: { Cookie: login.headers.get("set-cookie")!.split(";")[0]! } });
  assert.equal(result.status, 302);
  assert.equal(result.headers.get("location"), returnTo);
  const cookie = result.headers.get("set-cookie")!.split(";")[0]!;
  const me = await json("/api/portal/me", undefined, { Cookie: cookie });
  assert.equal(me.user.id, users.owner!.id);
  assert.equal(runtime.store.user(users.owner!.id)!.oauth!.refreshToken, "audit-refresh-token");
  assert.ok(!JSON.stringify(me).includes("audit-refresh-token"));
  const decision = { code: start.data.userCode, decision: "approve", scopes: ["read", "create"], userId: users.ada!.id };
  assert.equal((await json("/api/agent/device/decision", decision, { Cookie: cookie })).status, 403);
  assert.equal((await json("/api/agent/device/decision", decision, { Cookie: cookie, "X-CSRF-Token": me.csrf, Origin: "https://evil.invalid" })).status, 403);
  assert.equal((await json("/api/agent/device/decision", decision, { Cookie: cookie, "X-CSRF-Token": me.csrf })).status, 200);
  const issued = await json("/api/agent/device/token", { deviceCode: start.data.deviceCode });
  const bearer = { Authorization: `Bearer ${issued.data.accessToken}` };
  assert.equal(issued.data.account.id, users.owner!.id);
  assert.equal((await json("/api/agent/v1/account", undefined, { Cookie: cookie })).status, 401, "session alone cannot call bearer API");
  const account = await json("/api/agent/v1/account", undefined, bearer);
  assert.equal(account.data.capabilities.fixedDeadlineUsdc, true);
  const prep = await json("/api/agent/v1/prepare", { items: [w.item(101, { rewardUsdc: "12.34" }), w.item(102, { rewardUsdc: "0.01" })] }, bearer);
  assert.equal(prep.data.total.amount, "12.35");
  const created = await json("/api/agent/v1/batches", { preparationId: prep.data.preparationId }, bearer);
  assert.equal(created.data.counts.published, 2, JSON.stringify(created));
  for (let i = 0; i < 3; i++) {
    for (const task of w.tasks.all()) w.tasks.enqueue(task.id);
    await w.service.tick(); await runtime.portal.tick();
  }
  const funding = await json(`/api/agent/v1/funding?batch=${created.data.batchId}`, undefined, bearer);
  assert.deepEqual(funding.data.bounties.map((b: any) => b.exactAmountUnits), ["12340000", "10000"]);
  assert.equal(new Set(funding.data.bounties.map((b: any) => b.depositAddress)).size, 2);
  assert.ok(funding.data.bounties.every((b: any) => b.depositAddress && b.simulated && !b.claimsOpen));
  assert.ok(w.tasks.all().every((task) => !task.funded && task.payment.state === "NotRequested"));
  const activity = await json("/api/agent/v1/activity", undefined, bearer);
  assert.equal(activity.data.counts.created, 2);
  assert.equal(activity.data.payments.length, 0);
  assert.equal(oauthCalls.length, 2, "OAuth endpoints were stubbed, never contacted");
  assert.equal(w.gh.issues.length, 0);
});
