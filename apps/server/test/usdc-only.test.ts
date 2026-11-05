import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

test("USDC-only runtime boots without bank keys and publishes USDC independently of the bank deployment", async (t) => {
  const previous = { ...process.env }, originalFetch = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), "np-usdc-only-"));
  const contract = "usdc.fixture.testnet";
  process.env = { PATH: previous.PATH, ENV_FILE: "/dev/null", DATA_DIR: dir,
    TASK_PAYMENT_MODE: "sandbox", TASK_GITHUB_MODE: "live", TASK_BANK_ENABLED: "0",
    NEARPORTAL_MAINTENANCE: "0", NEAR_CREDENTIALS_DIR: join(dir, "no-keys"),
    CRYPTO_USDC_ENABLED: "1", CRYPTO_ESCROW_CONTRACT_ID: contract,
    CRYPTO_CLIENT_ACCOUNT_ID: "client.fixture.testnet", CRYPTO_VERIFIER_ACCOUNT_ID: "verifier.fixture.testnet",
    CRYPTO_RELAYER_ACCOUNT_ID: "relayer.fixture.testnet", MARKET_VERIFIED_CODE_HASHES: "reviewed-fixture-hash",
    PORTAL_OPEN_BOUNTY_ENABLED: "1", NEAR_RPC: "https://rpc.fixture.invalid",
    PORTAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"), GITHUB_USE_CLI: "0" };
  const external: string[] = [];
  const queriedAccounts: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") return originalFetch(input, init);
    external.push(url.href);
    assert.equal(url.origin, "https://rpc.fixture.invalid", "no banking or real providers");
    const body = JSON.parse(String(init?.body));
    queriedAccounts.push(body.params?.account_id);
    assert.equal(body.method, "query", "no chain mutation during startup or publish");
    assert.equal(body.params.account_id, contract, "no bank-contract dependency");
    const result = body.params.request_type === "view_account" ? { code_hash: "reviewed-fixture-hash" } : {
      result: [...Buffer.from(JSON.stringify(body.params.method_name === "get_crypto_operator"
        ? [process.env.CRYPTO_CLIENT_ACCOUNT_ID, process.env.CRYPTO_VERIFIER_ACCOUNT_ID] : null))],
      logs: [], block_height: 1, block_hash: "11111111111111111111111111111111",
    };
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  };
  t.after(() => { process.env = previous; globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });
  const { taskRuntime } = await import("../server/tasks/http.ts");
  const { portalRuntime } = await import("../server/portal/http.ts");
  const { GitHub } = await import("../server/tasks/github.ts");
  const { bountyModeCapabilities } = await import("../server/portal/market-rollout.ts");
  const { service } = await taskRuntime();
  assert.equal(service.config.verifier, "verifier.fixture.testnet");
  t.after(() => service.store.close());
  const github = new GitHub({ token: "fixture" }, async () => Response.json({ id: 100, full_name: "owner/test", private: false,
    allow_squash_merge: true, default_branch: "main", permissions: { push: true } }));
  const runtime = await portalRuntime(service, { githubFor: () => github });
  assert.deepEqual(bountyModeCapabilities.fixedDeadlineRails, { bank: false, "base-usdc": true });
  assert.ok(external.length > 0, "USDC deployment was checked");
  assert.ok(queriedAccounts.every((account) => account === contract), "no swallowed bank-provider probe");
  const owner = { id: 100, login: "owner", name: "Owner", avatar: "", token: "fixture-token", createdAt: new Date().toISOString(),
    bank: { clientId: "stale-bank-id", clientSecret: "stale-bank-secret", connectedAt: new Date().toISOString() } };
  let cookie = "";
  runtime.auth.login({ setHeader: (name: string, value: string) => { if (name === "Set-Cookie") cookie = value.split(";")[0]!; } } as any, owner);
  const csrf = runtime.auth.session({ headers: { cookie } } as any)!.csrf;
  runtime.store.meta("operator", String(owner.id));
  assert.equal(runtime.treasury.allowed(owner.id), false);
  await assert.rejects(() => service.create({ paymentRail: "bank" }), /Bank payments are disabled/);
  const server = createServer((req, res) => void runtime.handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/portal`;
  const me = await (await fetch(base + "/me", { headers: { Cookie: cookie } })).json() as any;
  assert.equal(me.bankConnected, false);
  assert.equal(me.openBountyReady, false);
  assert.equal(me.cryptoPaymentsReady, true);
  const request = async (path: string, body: unknown) => {
    const response = await fetch(base + path, { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const draft = { repository: "owner/test", title: "Rehearsal", description: "Add the fixture", criteria: "Tests pass", amountCents: 1, paymentRail: "base-usdc" };
  const created = await request("/bounties", draft);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const published = await request(`/bounties/${created.body.bounty.id}/publish`, { revision: created.body.bounty.revision });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(runtime.store.bounty(created.body.bounty.id).status, "Preparing");
  const bank = await request("/bounties", { ...draft, paymentRail: "bank" });
  assert.equal(bank.status, 400); assert.match(bank.body.error, /Bank payments are disabled/);
  const connected = await request("/bank", { clientId: "new-id", clientSecret: "new-secret" });
  assert.equal(connected.status, 400); assert.match(connected.body.error, /Bank payments are disabled/);
  await assert.rejects(() => service.payments.prepare({ policy: { paymentRail: "bank" }, ownerId: owner.id } as any), /Bank payments are disabled/);
});
