// Independent regressions: temporary SQLite, loopback HTTP, simulated escrow and GitHub only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWorld, users, H, type AgentWorld } from "./agent-world.ts";
import { ApiError, NearPortalClient } from "../mcp/client.ts";
import { credentials } from "../mcp/credentials.ts";
import { digest } from "../server/portal/store.ts";
import { registerTools } from "../mcp/tools.ts";

async function assigned(w: AgentWorld) {
  const owner = await w.login("owner");
  const ada = await w.login("ada", ["read", "contribute", "release"]);
  const wallet = await w.verifyWallet("ada", ada, 1);
  const b = await w.bounty(owner, { delivery: { hours: 1 } });
  const agreement = w.markets.get(b.id).policyHash;
  const body = { walletAddress: wallet, acceptedAgreementHash: agreement, idempotencyKey: "audit-claim-original" };
  const claim = () => w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: ada, body });
  assert.equal((await claim()).status, 200);
  await w.pass(2);
  return { owner, ada, wallet, b, body, claim, assignment: w.markets.get(b.id).assignment! };
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

test("audit: funding summaries never request another deposit for confirmed bounties", async () => {
  const callbacks = new Map<string, (a: any) => Promise<any>>();
  const address = "0x" + "1".repeat(40);
  let rows: any[] = [{ code: "NP-0000000001", amount: "0.01", exactAmountUnits: "10000", fundingState: "confirmed", depositAddress: null, addressVerified: false }];
  registerTools({ registerTool: (name: string, _schema: unknown, callback: any) => callbacks.set(name, callback) } as any, {
    call: async () => ({ bounties: rows, total: { amount: "0.02" } }),
  } as any);
  const read = async () => (await callbacks.get("get_funding_instructions")!({ batchId: "batch_" + "a".repeat(24) })).structuredContent;
  const funded = await read();
  assert.match(funded.summary, /Funding confirmed\. Do not send more funds\./);
  assert.doesNotMatch(funded.summary, /address not ready|Fund each bounty/);
  rows = [...rows,
    { code: "NP-0000000002", amount: "0.01", exactAmountUnits: "10000", fundingState: "awaiting-deposit", addressVerified: true, depositAddress: address, instruction: "Send exactly 0.01 test USDC on Base Sepolia." },
    { code: "NP-0000000003", amount: "0.01", exactAmountUnits: "10000", fundingState: "not-ready", addressVerified: false, depositAddress: null, instruction: "Address withheld." }];
  const mixed = await read();
  assert.match(mixed.summary, /Deposit address: 0x1{40}\. Send exactly 0.01 test USDC on Base Sepolia\./);
  assert.match(mixed.summary, /\[not-ready\]\. Do not send funds\. Address withheld\./);
  assert.match(mixed.summary, /Only fund bounties marked awaiting-deposit with a verified address/);
  assert.deepEqual(mixed.data.bounties, rows, "Structured funding facts stay unchanged");
});
// Pause an HTTP command on the real task lock, and signal when it has joined the queue.
async function holdTask(w: AgentWorld, id: string) {
  const entered = deferred(), unblock = deferred(), queued = deferred();
  const exclusive = w.service.exclusive.bind(w.service);
  const holder = exclusive(`task:${id}`, async () => { entered.resolve(); await unblock.promise; });
  await entered.promise;
  w.service.exclusive = ((key: string, work: () => unknown) => {
    const result = exclusive(key, work as any);
    if (key === `task:${id}`) queued.resolve();
    return result;
  }) as typeof w.service.exclusive;
  return { queued: queued.promise, release: async () => { unblock.resolve(); await holder; } };
}

test("audit: a completed claim key never acquires a later generation", async (t) => {
  const w = await agentWorld(); t.after(() => w.close());
  const a = await assigned(w);
  w.clock.now += 2 * H;
  await w.pass(2);
  assert.equal(w.markets.get(a.b.id).assignment, null);
  const replay = await a.claim();
  assert.equal(replay.error?.code, "idempotency_conflict", JSON.stringify(replay.body));
  assert.equal(w.markets.get(a.b.id).generation, 1);
  assert.equal(w.markets.get(a.b.id).assignment, null);
  const fresh = await w.call("POST", `/api/agent/v1/bounties/${a.b.id}/claim`, { bearer: a.ada, body: { ...a.body, idempotencyKey: "audit-claim-new-intent" } });
  assert.equal(fresh.data.assignment.generation, 2);
});

test("audit: a held assignment cannot acknowledge different accepted terms or wallet", async (t) => {
  const w = await agentWorld(); t.after(() => w.close());
  const a = await assigned(w);
  const wallet = await w.verifyWallet("ada", a.ada, 2);
  for (const patch of [{ walletAddress: wallet }, { acceptedAgreementHash: "b".repeat(64) }]) {
    const r = await w.call("POST", `/api/agent/v1/bounties/${a.b.id}/claim`, { bearer: a.ada, body: { ...a.body, ...patch, idempotencyKey: undefined } });
    assert.notEqual(r.status, 200, "must refuse a different commitment, not report successful replay");
  }
  assert.equal(w.tasks.get(a.b.taskId!).policy.recipient, a.wallet);
});

test("audit: submission received before deadline survives waiting for the worker lock", async (t) => {
  const w = await agentWorld(); t.after(() => w.close());
  const a = await assigned(w);
  w.pr(33, users.ada, a.assignment.marker);
  w.clock.now = a.assignment.deadline - 1;
  const hold = await holdTask(w, a.b.taskId!); t.after(() => hold.release());
  const pending = w.call("POST", `/api/agent/v1/bounties/${a.b.id}/submit`, { bearer: a.ada, body: { generation: 1, prUrl: "https://github.com/acme/widgets/pull/33" } });
  await hold.queued;
  w.clock.now += 10_000;
  await hold.release();
  const r = await pending;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(Date.parse(r.data.receivedAt), a.assignment.deadline - 1);
});

test("audit: submission generation is checked after acquiring the lock", async (t) => {
  const w = await agentWorld(); t.after(() => w.close());
  const a = await assigned(w);
  const hold = await holdTask(w, a.b.taskId!); t.after(() => hold.release());
  const pending = w.call("POST", `/api/agent/v1/bounties/${a.b.id}/submit`, { bearer: a.ada, body: { generation: 1, prUrl: "https://github.com/acme/widgets/pull/34" } });
  await hold.queued;
  // Model the preceding lock holder expiring/rebinding the assignment before the queued call runs.
  w.clock.now += 2 * H;
  await w.fixed.step(w.tasks.get(a.b.taskId!));
  w.fixed.claim(a.b, users.ada!, { acceptedPolicyHash: a.body.acceptedAgreementHash }, { kind: "usdc", address: a.wallet, proofVersion: digest(a.wallet) }, true);
  await w.fixed.step(w.tasks.get(a.b.taskId!));
  await w.fixed.step(w.tasks.get(a.b.taskId!));
  w.pr(34, users.ada!, w.markets.get(a.b.id).assignment!.marker);
  await hold.release();
  const r = await pending;
  assert.equal(r.error?.code, "wrong_generation", JSON.stringify(r.body));
  assert.equal(w.markets.get(a.b.id).assignment!.submission, null);
});

test("audit: a resumed batch never publishes a draft edited since preparation", async (t) => {
  const w = await agentWorld(); t.after(() => w.close());
  const owner = await w.login("owner");
  const prep = await w.call("POST", "/api/agent/v1/prepare", { bearer: owner, body: { items: [w.item(99)] } });
  const body = { preparationId: prep.data.preparationId };
  const publish = w.portal.publish.bind(w.portal);
  w.portal.publish = () => { throw new Error("Injected interruption before publish"); };
  const first = await w.call("POST", "/api/agent/v1/batches", { bearer: owner, body });
  const id = first.data.items[0].bountyId;
  w.portalStore.update(id, (b) => { b.amountCents = 99_999; });
  w.portal.publish = publish;
  const replay = await w.call("POST", "/api/agent/v1/batches", { bearer: owner, body });
  assert.equal(replay.data.items[0].error?.code, "agreement_changed", JSON.stringify(replay.body));
  assert.equal(w.portalStore.bounty(id).status, "Draft");
});

test("audit: interrupted or invalid mutation responses always preserve outcome uncertainty", async () => {
  const origin = "https://np.invalid";
  const replies = [
    () => new Response("truncated", { status: 200 }),
    () => new Response("{}", { status: 200 }),
    () => new Response(JSON.stringify({ error: "proxy failure" }), { status: 502 }),
    () => Object.assign(new Response("{}"), { json: async () => { throw new DOMException("body interrupted", "AbortError"); } }),
  ];
  for (const reply of replies) {
    let calls = 0;
    const request = (async () => ++calls === 1
      ? new Response(JSON.stringify({ ok: true, data: { origin, service: "nearportal-agent-api", apiVersion: 1 } })) : reply()) as typeof fetch;
    const c = new NearPortalClient(origin, () => "npa_" + "a".repeat(43), { fetch: request });
    await assert.rejects(c.call("POST", "/api/agent/v1/batches", { mutation: true, body: {} }), (e: ApiError) => e.code === "outcome_uncertain");
    assert.equal(calls, 2, "no automatic retry");
  }
});

test("audit: file credentials refuse a config path symlinked into a Git checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "np-audit-credentials-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "config"));
  symlinkSync(join(repo, "config"), join(root, "alias"), "dir");
  const saved = { ...process.env };
  try {
    process.env.NEARPORTAL_MCP_HOME = join(root, "alias");
    process.env.NEARPORTAL_CREDENTIAL_STORE = "file";
    assert.throws(() => credentials.save("https://np.invalid", "npa_" + "a".repeat(43), { login: "audit", userId: 1, tokenId: "x", expiresAt: "2099-01-01", scopes: ["read"] }), /Git work tree/);
  } finally { process.env = saved; }
});

test("audit: confirmation polling failure never erases an acknowledged claim", async () => {
  const callbacks = new Map<string, (a: any) => Promise<any>>();
  registerTools({ registerTool: (name: string, _schema: unknown, callback: any) => callbacks.set(name, callback) } as any, {
    call: async (method: string) => {
      if (method === "POST") return { __requestId: "acknowledged-claim", replayed: false, assignment: { confirmed: false, generation: 1, code: "NP-0123456789" } };
      throw new ApiError("provider_unavailable", "Read timeout", 10);
    },
  } as any);
  const result = await callbacks.get("claim_bounty")!({ bounty: "NP-0123456789", walletAddress: "0x" + "1".repeat(40), acceptedAgreementHash: "a".repeat(64), waitForConfirmationSeconds: 1 });
  assert.equal(result.structuredContent.ok, true, JSON.stringify(result));
  assert.equal(result.structuredContent.data.assignment.generation, 1);
  assert.equal(result.structuredContent.data.confirmationError.code, "provider_unavailable");
  assert.doesNotMatch(result.structuredContent.summary, /nothing was changed/i);
});

test("audit: claim receipt rolls back with the assignment and survives database restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "np-audit-restart-"));
  const path = join(dir, "audit.sqlite");
  const w = await agentWorld({ dir, path });
  let closed = false;
  try {
    const owner = await w.login("owner"), ada = await w.login("ada");
    const wallet = await w.verifyWallet("ada", ada, 1);
    const b = await w.bounty(owner, { delivery: { hours: 1 } });
    const body = { walletAddress: wallet, acceptedAgreementHash: w.markets.get(b.id).policyHash, idempotencyKey: "audit-atomic-receipt" };
    const remember = w.api.agent.remember.bind(w.api.agent);
    w.api.agent.remember = () => { throw new Error("Injected receipt write failure"); };
    assert.notEqual((await w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: ada, body })).status, 200);
    assert.equal(w.markets.get(b.id).assignment, null, "assignment must roll back if its receipt cannot be stored");
    assert.equal(w.tasks.get(b.taskId!).policy.developerId, 0);
    w.api.agent.remember = remember;
    assert.equal((await w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: ada, body })).status, 200);
    await w.pass(2);
    await w.close(); closed = true;
    const restarted = await agentWorld({ dir, path });
    try {
      restarted.clock.now += 2 * H;
      await restarted.pass(2);
      const r = await restarted.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: ada, body });
      assert.equal(r.error?.code, "idempotency_conflict");
      assert.equal(restarted.markets.get(b.id).assignment, null);
    } finally { await restarted.close(); }
  } finally { if (!closed) await w.close(); }
});

test("audit: private repository access and owner-only batch/funding views are enforced", async (t) => {
  const w = await agentWorld(); t.after(() => w.close());
  const owner = await w.login("owner"), ada = await w.login("ada");
  const wallet = await w.verifyWallet("ada", ada, 1);
  const b = await w.bounty(owner, { repository: "acme/secret" });
  const body = { walletAddress: wallet, acceptedAgreementHash: w.markets.get(b.id).policyHash };
  const denied = await w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: ada, body });
  assert.equal(denied.error?.code, "repository_access_required");
  assert.equal(w.markets.get(b.id).assignment, null);
  assert.equal((await w.call("GET", `/api/agent/v1/funding?bounty=${b.id}`, { bearer: ada })).error?.code, "forbidden");
  const prep = await w.call("POST", "/api/agent/v1/prepare", { bearer: owner, body: { items: [w.item(222)] } });
  const batch = await w.call("POST", "/api/agent/v1/batches", { bearer: owner, body: { preparationId: prep.data.preparationId } });
  assert.equal((await w.call("GET", `/api/agent/v1/batches/${batch.data.batchId}`, { bearer: ada })).error?.code, "not_found");
  assert.equal((await w.call("GET", `/api/agent/v1/funding?batch=${batch.data.batchId}`, { bearer: ada })).error?.code, "not_found");
});
