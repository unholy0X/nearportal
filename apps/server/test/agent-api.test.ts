// Agent (MCP) API over HTTP against the real services: authorization (device flow, scopes,
// expiry, revocation), reusable wallet verification, claim/submit/release through the shared
// fixed-deadline engine, batch preparation/creation/resume, funding instructions and activity.
// Simulated escrow chain + mock GitHub + controlled clock; temporary databases; no external calls.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { agentWorld, users, walletOf, H, type AgentWorld } from "./agent-world.ts";
import { fixtureEvidence } from "../server/tasks/github.ts";
import { loginReturnPath } from "../server/portal/auth.ts";

async function claimed(w: AgentWorld) {
  const owner = await w.login("owner");
  const ada = await w.login("ada", ["read", "contribute", "release"]);
  const b = await w.bounty(owner);
  const wallet = await w.verifyWallet("ada", ada, 1);
  const terms = await w.call("GET", `/api/agent/v1/bounties/${b.id}`, { bearer: ada });
  const c = await w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: ada, body: { walletAddress: wallet, acceptedAgreementHash: terms.data.agreement.hash } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  await w.pass(2);
  const a = await w.call("GET", `/api/agent/v1/bounties/${b.id}/assignment`, { bearer: ada });
  assert.equal(a.data.state, "in-progress");
  return { owner, ada, b, wallet, terms: terms.data, assignment: a.data };
}

// ---------------- 3-6: authorization ----------------
test("device flow: GET never approves, polling never approves, the approving session defines the identity", async () => {
  const w = await agentWorld();
  // The CLI asks; a body userId has no authority anywhere.
  const start = await w.call("POST", "/api/agent/device/code", { body: { clientName: "cli", scopes: ["read", "contribute"], userId: users.owner.id } });
  assert.equal(start.status, 200);
  assert.match(start.data.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.ok(!start.data.verificationUri.includes(start.data.deviceCode), "the device secret is never in a URL");
  for (let i = 0; i < 3; i++) {
    w.clock.now += 6_000;
    assert.equal((await w.call("POST", "/api/agent/device/token", { body: { deviceCode: start.data.deviceCode } })).data.status, "pending");
  }
  const look = await w.call("GET", `/api/agent/device/lookup?code=${start.data.userCode}`, { session: "ada" });
  assert.equal(look.data.status, "pending");
  assert.equal(look.data.account.login, "dev-ada");
  assert.equal((await w.call("GET", `/api/agent/device/decision?code=${start.data.userCode}&decision=approve`, { session: "ada" })).status, 404, "no approval by GET");
  // CSRF and cross-origin protections on the approval POST.
  assert.equal((await w.call("POST", "/api/agent/device/decision", { session: "ada", csrf: false, body: { code: start.data.userCode, decision: "approve", scopes: ["read"] } })).status, 403);
  assert.equal((await w.call("POST", "/api/agent/device/decision", { session: "ada", origin: "https://evil.example", body: { code: start.data.userCode, decision: "approve", scopes: ["read"] } })).status, 403);
  assert.equal((await w.call("POST", "/api/agent/device/decision", { body: { code: start.data.userCode, decision: "approve", scopes: ["read"] } })).status, 401, "no session, no approval");
  assert.equal((await w.call("GET", `/api/agent/device/lookup?code=${start.data.userCode}`, { session: "ada" })).data.status, "pending", "nothing above approved it");
  const ok = await w.call("POST", "/api/agent/device/decision", { session: "ada", body: { code: start.data.userCode, decision: "approve", scopes: ["read", "contribute"] } });
  assert.equal(ok.status, 200);
  w.clock.now += 6_000;
  const token = await w.call("POST", "/api/agent/device/token", { body: { deviceCode: start.data.deviceCode } });
  assert.equal(token.data.status, "approved");
  assert.equal(token.data.account.login, "dev-ada", "identity = approving session, not the body userId");
  const account = await w.call("GET", "/api/agent/v1/account", { bearer: token.data.accessToken });
  assert.equal(account.data.account.id, users.ada.id);
  assert.ok(!JSON.stringify(account.body).includes(token.data.accessToken), "responses never echo the credential");
  // Single use: neither the code nor the device secret can be reused.
  assert.equal((await w.call("POST", "/api/agent/device/token", { body: { deviceCode: start.data.deviceCode } })).error.code, "challenge_used");
  assert.equal((await w.call("POST", "/api/agent/device/decision", { session: "bo", body: { code: start.data.userCode, decision: "approve", scopes: ["read"] } })).error.code, "challenge_used");
  // Only a hash is stored.
  const stored = w.tasks.db.prepare("SELECT hash FROM agent_tokens").all() as { hash: string }[];
  assert.ok(stored.every((r) => r.hash !== token.data.accessToken && /^[a-f0-9]{64}$/.test(r.hash)));
  await w.close();
});

test("device flow: expired challenge, wrong account and denial are refused; polling too fast slows down", async () => {
  const w = await agentWorld();
  const a = await w.call("POST", "/api/agent/device/code", { body: { clientName: "cli", scopes: ["read"] } });
  w.clock.now += 11 * 60_000;
  assert.equal((await w.call("POST", "/api/agent/device/decision", { session: "ada", body: { code: a.data.userCode, decision: "approve", scopes: ["read"] } })).error.code, "challenge_expired");
  assert.equal((await w.call("POST", "/api/agent/device/token", { body: { deviceCode: a.data.deviceCode } })).data.status, "expired");
  const b = await w.call("POST", "/api/agent/device/code", { body: { clientName: "cli", scopes: ["read"], expectedLogin: "dev-ada" } });
  assert.equal((await w.call("POST", "/api/agent/device/decision", { session: "bo", body: { code: b.data.userCode, decision: "approve", scopes: ["read"] } })).error.code, "wrong_account");
  const c = await w.call("POST", "/api/agent/device/code", { body: { clientName: "cli", scopes: ["read"] } });
  await w.call("POST", "/api/agent/device/token", { body: { deviceCode: c.data.deviceCode } });
  assert.equal((await w.call("POST", "/api/agent/device/token", { body: { deviceCode: c.data.deviceCode } })).data.status, "slow_down");
  await w.call("POST", "/api/agent/device/decision", { session: "ada", body: { code: c.data.userCode, decision: "deny" } });
  w.clock.now += 20_000;
  assert.equal((await w.call("POST", "/api/agent/device/token", { body: { deviceCode: c.data.deviceCode } })).data.status, "denied");
  // A scope that was not requested cannot be approved.
  const d = await w.call("POST", "/api/agent/device/code", { body: { clientName: "cli", scopes: ["read"] } });
  assert.equal((await w.call("POST", "/api/agent/device/decision", { session: "ada", body: { code: d.data.userCode, decision: "approve", scopes: ["read", "create"] } })).error.code, "invalid_input");
  // Login return paths for the agent pages are exact.
  assert.equal(loginReturnPath(`/agent/connect?code=${d.data.userCode}`), `/agent/connect?code=${d.data.userCode}`);
  assert.equal(loginReturnPath("/agent/connect?code=ABCD-EFGH&next=https://evil"), "/app");
  await w.close();
});

test("scopes are enforced on the server for every route; expiry and revocation take effect on the next request", async () => {
  const w = await agentWorld();
  const reader = await w.login("ada", ["read"]);
  const contributor = await w.login("bo", ["read", "contribute"]);
  const owner = await w.login("owner", ["read", "create"]);
  const b = await w.bounty(owner);
  assert.equal((await w.call("GET", "/api/agent/v1/bounties", { bearer: reader })).status, 200);
  assert.equal((await w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: reader, body: {} })).error.code, "insufficient_scope");
  assert.equal((await w.call("POST", "/api/agent/v1/wallets/verify", { bearer: reader, body: { address: walletOf(1).address } })).error.code, "insufficient_scope");
  assert.equal((await w.call("POST", "/api/agent/v1/prepare", { bearer: contributor, body: { items: [w.item(1)] } })).error.code, "insufficient_scope");
  assert.equal((await w.call("POST", "/api/agent/v1/batches", { bearer: contributor, body: { preparationId: "prep_" + "0".repeat(24) } })).error.code, "insufficient_scope");
  assert.equal((await w.call("POST", `/api/agent/v1/bounties/${b.id}/release`, { bearer: contributor, body: {} })).error.code, "insufficient_scope");
  assert.equal((await w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: owner, body: {} })).error.code, "insufficient_scope");
  assert.equal((await w.call("GET", "/api/agent/v1/account")).error.code, "not_authenticated");
  assert.equal((await w.call("GET", "/api/agent/v1/account", { bearer: "npa_" + "x".repeat(43) })).error.code, "not_authenticated");
  // Browser cookies never authenticate bearer routes.
  assert.equal((await w.call("GET", "/api/agent/v1/account", { session: "ada" })).error.code, "not_authenticated");
  // Revocation from the browser session, effective immediately.
  const list = await w.call("GET", "/api/agent/session/tokens", { session: "ada" });
  const id = list.data.credentials[0].id;
  assert.equal((await w.call("POST", `/api/agent/session/tokens/${id}/revoke`, { session: "ada" })).data.revoked, true);
  assert.equal((await w.call("GET", "/api/agent/v1/account", { bearer: reader })).error.code, "credential_revoked");
  // Logout revokes the calling credential.
  assert.equal((await w.call("POST", "/api/agent/v1/logout", { bearer: contributor, body: {} })).data.revoked, true);
  assert.equal((await w.call("GET", "/api/agent/v1/account", { bearer: contributor })).error.code, "credential_revoked");
  // Expiry (30 days by default).
  w.clock.now += 31 * 24 * H;
  assert.equal((await w.call("GET", "/api/agent/v1/account", { bearer: owner })).error.code, "credential_expired");
  // No CORS is ever granted.
  const r = await w.call("GET", "/api/agent/v1/meta");
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  await w.close();
});

// ---------------- 7-8: wallet ----------------
test("wallet: unverified claim refused; challenge single-use; replayed or foreign signature refused; account and network bound", async () => {
  const w = await agentWorld();
  const owner = await w.login("owner");
  const ada = await w.login("ada");
  const bo = await w.login("bo");
  const b = await w.bounty(owner);
  const terms = (await w.call("GET", `/api/agent/v1/bounties/${b.id}`, { bearer: ada })).data;
  assert.ok(terms.availability.blockers.some((x: string) => x.startsWith("wallet_not_verified")));
  const addr = walletOf(1).address.toLowerCase();
  assert.equal((await w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: ada, body: { walletAddress: addr, acceptedAgreementHash: terms.agreement.hash } })).error.code, "wallet_not_verified");
  assert.equal((await w.call("POST", "/api/agent/v1/wallets/verify", { bearer: ada, body: { address: addr, network: "ethereum" } })).error.code, "wrong_network");
  const started = (await w.call("POST", "/api/agent/v1/wallets/verify", { bearer: ada, body: { address: addr } })).data;
  assert.equal(started.verified, false);
  assert.match(started.verificationUrl, /\/agent\/wallet\?request=/);
  // Another GitHub account cannot read or complete it.
  assert.equal((await w.call("GET", `/api/agent/session/wallet-requests/${started.requestId}`, { session: "bo" })).error.code, "not_found");
  const page = (await w.call("GET", `/api/agent/session/wallet-requests/${started.requestId}`, { session: "ada" })).data;
  assert.match(page.message, /GitHub account: @dev-ada \(ID 2002\)/);
  assert.match(page.message, /chain ID 84532/);
  assert.match(page.message, new RegExp(`Origin: ${w.origin}`));
  // A signature by another key is refused and does not consume the challenge.
  const wrong = await walletOf(2).signMessage({ message: page.message });
  assert.equal((await w.call("POST", `/api/agent/session/wallet-requests/${started.requestId}/verify`, { session: "ada", body: { signature: wrong } })).error.code, "invalid_signature");
  const signature = await walletOf(1).signMessage({ message: page.message });
  assert.equal((await w.call("POST", `/api/agent/session/wallet-requests/${started.requestId}/verify`, { session: "bo", body: { signature } })).error.code, "not_found");
  assert.equal((await w.call("POST", `/api/agent/session/wallet-requests/${started.requestId}/verify`, { session: "ada", csrf: false, body: { signature } })).status, 403, "CSRF required");
  assert.equal((await w.call("POST", `/api/agent/session/wallet-requests/${started.requestId}/verify`, { session: "ada", body: { signature } })).data.verified, true);
  // Replay of the same signature / challenge.
  assert.equal((await w.call("POST", `/api/agent/session/wallet-requests/${started.requestId}/verify`, { session: "ada", body: { signature } })).error.code, "challenge_used");
  const second = (await w.call("POST", "/api/agent/v1/wallets/verify", { bearer: ada, body: { address: walletOf(3).address } })).data;
  assert.equal((await w.call("POST", `/api/agent/session/wallet-requests/${second.requestId}/verify`, { session: "ada", body: { signature } })).error.code, "invalid_signature", "a signature for another challenge is useless");
  // Agent sees only the result.
  const status = (await w.call("GET", `/api/agent/v1/wallets/requests/${started.requestId}`, { bearer: ada })).data;
  assert.equal(status.verified, true);
  assert.ok(!JSON.stringify(status).includes(signature));
  // Reuse is per account: bo cannot use ada's verified wallet.
  assert.equal((await w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: bo, body: { walletAddress: addr, acceptedAgreementHash: terms.agreement.hash } })).error.code, "wallet_not_verified");
  assert.equal((await w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: ada, body: { walletAddress: addr, acceptedAgreementHash: terms.agreement.hash, network: "base-mainnet" } })).error.code, "wrong_network");
  // Expired challenge.
  const third = (await w.call("POST", "/api/agent/v1/wallets/verify", { bearer: ada, body: { address: walletOf(4).address } })).data;
  const msg = (await w.call("GET", `/api/agent/session/wallet-requests/${third.requestId}`, { session: "ada" })).data.message;
  w.clock.now += 11 * 60_000;
  assert.equal((await w.call("POST", `/api/agent/session/wallet-requests/${third.requestId}/verify`, { session: "ada", body: { signature: await walletOf(4).signMessage({ message: msg }) } })).error.code, "challenge_expired");
  // Verified wallet is reused without a new signature; revocation stops reuse.
  assert.equal((await w.call("POST", "/api/agent/v1/wallets/verify", { bearer: ada, body: { address: addr } })).data.verified, true);
  assert.equal((await w.call("POST", "/api/agent/v1/wallets/revoke", { bearer: ada, body: { address: addr } })).data.revoked, true);
  assert.equal((await w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: ada, body: { walletAddress: addr, acceptedAgreementHash: terms.agreement.hash } })).error.code, "wallet_not_verified");
  await w.close();
});

// ---------------- 9-12: claim ----------------
test("claim: refused before funding; concurrent claims have one winner; a lost response is reconciled; agreement and key bound", async () => {
  const w = await agentWorld();
  const owner = await w.login("owner");
  const ada = await w.login("ada");
  const bo = await w.login("bo");
  const adaWallet = await w.verifyWallet("ada", ada, 1);
  const boWallet = await w.verifyWallet("bo", bo, 2);
  const unfunded = await w.bounty(owner, {}, false);
  const claimUnfunded = () => w.call("POST", `/api/agent/v1/bounties/${unfunded.id}/claim`, { bearer: ada, body: { walletAddress: adaWallet, acceptedAgreementHash: "a".repeat(64) } });
  assert.equal((await claimUnfunded()).error.code, "not_found", "an unfunded bounty is not even visible to developers");
  w.portalStore.update(unfunded.id, (b) => { b.published = true; }); // even if it were visible
  assert.equal((await claimUnfunded()).error.code, "bounty_not_funded");
  const b = await w.bounty(owner);
  const hash = (await w.call("GET", `/api/agent/v1/bounties/${b.id}`, { bearer: ada })).data.agreement.hash;
  assert.equal((await w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: ada, body: { walletAddress: adaWallet, acceptedAgreementHash: "b".repeat(64) } })).error.code, "agreement_changed");
  const [x, y] = await Promise.all([
    w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: ada, body: { walletAddress: adaWallet, acceptedAgreementHash: hash, userId: users.bo.id } }),
    w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: bo, body: { walletAddress: boWallet, acceptedAgreementHash: hash } }),
  ]);
  const wins = [x, y].filter((r) => r.status === 200);
  assert.equal(wins.length, 1, JSON.stringify([x.body, y.body]));
  const loser = [x, y].find((r) => r.status !== 200)!;
  assert.equal(loser.error.code, "bounty_already_assigned");
  const winner = x.status === 200 ? { token: ada, wallet: adaWallet, user: users.ada } : { token: bo, wallet: boWallet, user: users.bo };
  assert.equal(w.tasks.get(b.taskId!).policy.developerId, winner.user.id, "identity from the token, never from the body");
  // Retry after a lost response: same request → same assignment, no second claim.
  const retry = await w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: winner.token, body: { walletAddress: winner.wallet, acceptedAgreementHash: hash } });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.replayed, true);
  assert.equal(retry.data.assignment.generation, 1);
  assert.equal(w.markets.get(b.id).generation, 1);
  // Same key, different content → conflict.
  const other = await w.verifyWallet(winner.user === users.ada ? "ada" : "bo", winner.token, 5);
  const conflict = await w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: winner.token, body: { walletAddress: other, acceptedAgreementHash: hash, idempotencyKey: "claim-key-1" } });
  assert.equal(conflict.error.code, "idempotency_conflict", "a different payout commitment must be refused");
  assert.equal(w.tasks.get(b.taskId!).policy.recipient, winner.wallet, "recipient immutable");
  assert.equal((await w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: winner.token, body: { walletAddress: winner.wallet, acceptedAgreementHash: hash, idempotencyKey: "claim-key-1" } })).error.code, "idempotency_conflict");
  await w.close();
});

test("assignment, generation and deadline persist across a restart; the deadline never restarts", async () => {
  const dir = (await import("node:fs")).mkdtempSync(join((await import("node:os")).tmpdir(), "np-agent-restart-"));
  const path = join(dir, "db.sqlite");
  const w1 = await agentWorld({ path, dir });
  const { ada, b, assignment } = await claimed(w1);
  await w1.close();
  // A new port: fetch could otherwise reuse a pooled socket of the closed server (ECONNRESET).
  const w2 = await agentWorld({ path, dir });
  try {
    w2.clock.now += 5 * H; // the terminal and server restart later
    const a = await w2.call("GET", `/api/agent/v1/bounties/${b.id}/assignment`, { bearer: ada });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.data.generation, assignment.generation);
    assert.equal(a.data.marker, assignment.marker);
    assert.equal(a.data.deadline, assignment.deadline);
    assert.equal(a.data.remainingSecondsIndicative, assignment.remainingSecondsIndicative - 5 * 3600);
  } finally {
    await w2.close(); // an open server would keep the test process alive
  }
});

// ---------------- 13-14: submission ----------------
test("submit: wrong repository, wrong author, wrong generation, after the deadline; exact commit and reception time recorded", async () => {
  const w = await agentWorld();
  const { ada, b, assignment } = await claimed(w);
  const submit = (body: Record<string, unknown>) => w.call("POST", `/api/agent/v1/bounties/${b.id}/submit`, { bearer: ada, body });
  assert.equal((await submit({ prUrl: "https://github.com/other/repo/pull/7", generation: 1 })).error.code, "invalid_pull_request");
  assert.equal((await submit({ prUrl: "https://gitlab.com/acme/widgets/pull/7", generation: 1 })).error.code, "invalid_pull_request");
  assert.equal((await submit({ prNumber: 7, generation: 1 })).error.code, "invalid_pull_request", "a bare number needs the repository");
  w.pr(8, users.bo, assignment.marker);
  assert.equal((await submit({ prUrl: "https://github.com/acme/widgets/pull/8", generation: 1 })).error.code, "invalid_pull_request", "another author");
  w.pr(9, users.ada, "NP-0000000000-A1");
  assert.equal((await submit({ prUrl: "https://github.com/acme/widgets/pull/9", generation: 1 })).error.code, "invalid_pull_request", "missing marker");
  w.pr(7, users.ada, assignment.marker);
  assert.equal((await submit({ prUrl: "https://github.com/acme/widgets/pull/7", generation: 2 })).error.code, "wrong_generation");
  const ok = await submit({ prNumber: 7, repository: "acme/widgets", generation: 1 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.data.headSha, "a".repeat(40));
  assert.equal(ok.data.receivedAt, new Date(w.clock.now).toISOString());
  // Resubmission of the same commit is harmless (no second operation).
  const again = await submit({ prUrl: "https://github.com/acme/widgets/pull/7", generation: 1 });
  assert.equal(again.data.receivedAt, ok.data.receivedAt);
  // After the deadline the recorded commit is final.
  w.clock.now = Date.parse(assignment.deadline) + 1;
  w.pr(7, users.ada, assignment.marker, { head: { sha: "e".repeat(40) } });
  assert.equal((await submit({ prUrl: "https://github.com/acme/widgets/pull/7", generation: 1 })).error.code, "deadline_passed");
  assert.equal(w.markets.get(b.id).assignment!.submission!.headSha, "a".repeat(40));
  await w.close();
});

test("an unsubmitted assignment expires after deadline + grace; the next claim is a new generation", async () => {
  const w = await agentWorld();
  const { ada, b, assignment } = await claimed(w);
  w.clock.now = Date.parse(assignment.deadline) + 16 * 60_000;
  await w.pass(3);
  const a = await w.call("GET", `/api/agent/v1/bounties/${b.id}/assignment`, { bearer: ada });
  assert.equal(a.data.state, "expired");
  const bo = await w.login("bo");
  const wallet = await w.verifyWallet("bo", bo, 2);
  const hash = (await w.call("GET", `/api/agent/v1/bounties/${b.id}`, { bearer: bo })).data.agreement.hash;
  const c = await w.call("POST", `/api/agent/v1/bounties/${b.id}/claim`, { bearer: bo, body: { walletAddress: wallet, acceptedAgreementHash: hash } });
  assert.equal(c.data.assignment.generation, 2);
  assert.match(c.data.assignment.marker, /-A2$/);
  const act = (await w.call("GET", "/api/agent/v1/activity?kind=all", { bearer: ada })).data;
  assert.equal(act.expired_or_released[0].reason, "expired");
  await w.close();
});

test("release needs the release scope, the current generation and the exact confirmation phrase", async () => {
  const w = await agentWorld();
  const { ada, b, assignment } = await claimed(w);
  const release = (body: Record<string, unknown>) => w.call("POST", `/api/agent/v1/bounties/${b.id}/release`, { bearer: ada, body });
  assert.equal((await release({ generation: 1, confirm: "yes" })).error.code, "invalid_input");
  assert.equal((await release({ generation: 2, confirm: `RELEASE ${assignment.marker}` })).error.code, "wrong_generation");
  assert.equal((await release({ generation: 1, confirm: `RELEASE ${assignment.marker}` })).data.releaseRequested, true);
  assert.equal((await release({ generation: 1, confirm: `RELEASE ${assignment.marker}` })).data.releaseRequested, true, "repeat is harmless");
  await w.pass(3);
  assert.equal(w.markets.get(b.id).phase, "available");
  assert.equal(w.markets.get(b.id).history[0]!.reason, "withdrawn");
  await w.close();
});

// ---------------- 15, 22: verification and payment ----------------
test("selected job succeeds while an unselected job runs: paid once; merged is not paid; receipt only after confirmation", async () => {
  const w = await agentWorld();
  const { owner, ada, b, assignment } = await claimed(w);
  w.pr(7, users.ada, assignment.marker);
  await w.call("POST", `/api/agent/v1/bounties/${b.id}/submit`, { bearer: ada, body: { prUrl: "https://github.com/acme/widgets/pull/7", generation: 1 } });
  await w.pass(2);
  // Merged, but the selected job has not completed: merged ≠ paid.
  const t = w.tasks.get(b.taskId!);
  t.fixture = "merged";
  t.githubMode = "live";
  w.tasks.save(t);
  let evidence = fixtureEvidence(w.tasks.get(b.taskId!));
  evidence.checks[0]!.status = "in_progress";
  evidence.checks[0]!.conclusion = null;
  evidence.checks.push({ ...evidence.checks[0]!, id: 999, name: "lint", status: "in_progress", conclusion: null });
  w.service.github.evidence = async () => structuredClone(evidence);
  await w.pass(2);
  let act = (await w.call("GET", "/api/agent/v1/activity", { bearer: owner })).data;
  const row = act.created.find((r: any) => r.bountyId === b.id);
  assert.equal(row.merged, true);
  assert.notEqual(row.status.key, "paid");
  assert.equal(row.receipt, null);
  assert.equal(w.tasks.get(b.taskId!).payment.state, "NotRequested");
  // Selected job succeeds; the unselected one is still running: payment proceeds, once.
  evidence = fixtureEvidence(w.tasks.get(b.taskId!));
  evidence.mergeParents.push(evidence.headSha); // A regular merge completes the full fixed-deadline flow.
  evidence.runs[0]!.conclusion = null;
  evidence.checks.push({ ...evidence.checks[0]!, id: 999, name: "lint", status: "in_progress", conclusion: null });
  await w.pass(4);
  assert.equal(w.tasks.get(b.taskId!).payment.state, "Processed");
  act = (await w.call("GET", "/api/agent/v1/activity?kind=payments", { bearer: ada })).data;
  assert.equal(act.payments[0].status.key, "paid");
  assert.ok(act.payments[0].receipt?.reference, "receipt after confirmation");
  await w.pass(3);
  assert.equal((w.tasks.db.prepare("SELECT COUNT(*) AS n FROM releases").get() as { n: number }).n, 1);
  assert.equal(w.chain.calls.filter((c) => c.method === "settle_bounty").length, 1);
  await w.close();
});

// ---------------- 1, 16-21: creator flow ----------------
test("prepare validates without mutation and with bounded GitHub reads; exact totals", async () => {
  const w = await agentWorld();
  const owner = await w.login("owner");
  const rewards = ["0.01", "12.34", "100", "999.99", "1", "2.5", "0.99", "10.10", "50", "7"];
  const before = { bounties: w.portalStore.all().length, writes: w.gh.calls.filter((c) => !c.includes(" GET ")).length };
  const prep = await w.call("POST", "/api/agent/v1/prepare", { bearer: owner, body: { items: rewards.map((r, i) => w.item(i, { rewardUsdc: r, delivery: i % 2 ? { days: 2 } : { hours: 36 } })) } });
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  assert.equal(prep.data.valid, true);
  assert.equal(prep.data.total.count, 10);
  assert.equal(prep.data.total.amountCents, 1 + 1234 + 10000 + 99999 + 100 + 250 + 99 + 1010 + 5000 + 700);
  assert.equal(prep.data.total.amount, "1183.93");
  assert.equal(prep.data.total.units, "1183930000");
  assert.deepEqual(prep.data.items.map((i: any) => i.normalized.deliveryHours), [36, 48, 36, 48, 36, 48, 36, 48, 36, 48]);
  assert.deepEqual(prep.data.items[0].discoveredJobs, ["acceptance", "lint"]);
  assert.equal(w.portalStore.all().length, before.bounties, "no bounty created");
  assert.equal(w.gh.calls.filter((c) => !c.includes(" GET ")).length, before.writes, "no GitHub write");
  assert.equal(w.gh.calls.filter((c) => c.endsWith("GET /repos/acme/widgets")).length, 1, "one repository read for 10 items");
  // Validation errors are reported per item, before any mutation.
  const bad = await w.call("POST", "/api/agent/v1/prepare", { bearer: owner, body: { items: [
    w.item(1, { rewardUsdc: "1.234" }), w.item(2, { jobs: ["acceptance", "lint"] }), w.item(3, { jobs: ["e2e"] }), w.item(4, { refundAddress: "0x" + "0".repeat(40) }),
    w.item(5, { repository: "other/repo" }), w.item(6, { protectedPaths: ["missing.ts"] }), w.item(7, { delivery: { hours: 3000 } }), w.item(8, { surprise: true }), w.item(8), w.item(8),
  ] } });
  assert.equal(bad.data.valid, false);
  assert.equal(bad.data.preparationId, null);
  const errs = bad.data.items.map((i: any) => i.errors.join(" "));
  assert.match(errs[0], /rewardUsdc/);
  assert.match(errs[1], /exactly one job/);
  assert.match(errs[2], /not a job reported/);
  assert.match(errs[3], /refundAddress/);
  assert.match(errs[4], /write access/);
  assert.match(errs[5], /missing\.ts does not exist/);
  assert.match(errs[6], /delivery/);
  assert.match(errs[7], /surprise: unknown field/);
  assert.match(errs[9], /Duplicate/);
  assert.equal((await w.call("POST", "/api/agent/v1/prepare", { bearer: owner, body: { items: Array.from({ length: 11 }, (_, i) => w.item(i)) } })).error.code, "invalid_input");
  await w.close();
});

test("batch of 10: partial failure, resume without duplicates, key conflict, distinct funding instructions, no transfer", async () => {
  const w = await agentWorld();
  w.gh.squashEnabled = false; // Regular-merge repositories support the full creator flow.
  const owner = await w.login("owner");
  const items = Array.from({ length: 10 }, (_, i) => w.item(i, { rewardUsdc: String(10 + i) }));
  const prep = (await w.call("POST", "/api/agent/v1/prepare", { bearer: owner, body: { items } })).data;
  // Inject: item 3's creation fails (provider outage); item 6 is created but publishing fails.
  const create = w.portal.create.bind(w.portal), publish = w.portal.publish.bind(w.portal);
  let createCalls = 0;
  w.portal.create = (async (...args: Parameters<typeof create>) => {
    if (args[1].title === items[3]!.title && createCalls++ === 0) throw new Error("GitHub request failed (503)");
    return create(...args);
  }) as typeof create;
  let failPublish = true;
  w.portal.publish = ((u, b, rev) => {
    if (b.title === items[6]!.title && failPublish) { failPublish = false; throw new Error("This bounty changed while the update was in progress. Refresh and try again."); }
    return publish(u, b, rev);
  }) as typeof publish;
  const first = await w.call("POST", "/api/agent/v1/batches", { bearer: owner, body: { preparationId: prep.preparationId, batchKey: "launch-week-1" } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.data.counts.published, 8);
  assert.deepEqual(first.data.toResume, [3, 6]);
  assert.equal(first.data.items[3].creation, "failed");
  assert.equal(first.data.items[3].error.code, "provider_unavailable");
  assert.equal(first.data.items[6].creation, "created", "created but not yet published");
  assert.equal(w.portalStore.all().length, 9);
  // Same key, different content.
  const other = (await w.call("POST", "/api/agent/v1/prepare", { bearer: owner, body: { items: items.slice(0, 2) } })).data;
  assert.equal((await w.call("POST", "/api/agent/v1/batches", { bearer: owner, body: { preparationId: other.preparationId, batchKey: "launch-week-1" } })).error.code, "idempotency_conflict");
  // Resume.
  const second = await w.call("POST", "/api/agent/v1/batches", { bearer: owner, body: { preparationId: prep.preparationId, batchKey: "launch-week-1" } });
  assert.equal(second.data.counts.published, 10);
  assert.deepEqual(second.data.toResume, []);
  const third = await w.call("POST", "/api/agent/v1/batches", { bearer: owner, body: { preparationId: prep.preparationId, batchKey: "launch-week-1" } });
  assert.equal(third.data.counts.published, 10);
  assert.equal(w.portalStore.all().length, 10, "no duplicates after retries");
  assert.equal(new Set(w.portalStore.all().map((b) => b.title)).size, 10);
  // Nothing is available before funding, and nothing moved.
  await w.pass(3);
  const status = (await w.call("GET", `/api/agent/v1/batches/${second.data.batchId}`, { bearer: owner })).data;
  assert.ok(status.items.every((i: any) => i.status.key === "toFund" && !i.funded));
  const funding = (await w.call("GET", `/api/agent/v1/funding?batch=${second.data.batchId}`, { bearer: owner })).data;
  assert.equal(funding.bounties.length, 10);
  const addresses = funding.bounties.map((f: any) => f.depositAddress);
  assert.ok(addresses.every((a: string) => /^0x[0-9a-f]{40}$/.test(a)));
  assert.equal(new Set(addresses).size, 10, "one dedicated address per bounty");
  assert.deepEqual(funding.bounties.map((f: any) => f.amount), items.map((i) => `${i.rewardUsdc}.00`));
  assert.deepEqual(funding.bounties.map((f: any) => f.exactAmountUnits), items.map((i) => String(Number(i.rewardUsdc) * 1_000_000)));
  assert.equal(funding.total.amount, "145.00");
  assert.equal(funding.automaticFunding, false);
  assert.ok(funding.bounties.every((f: any) => f.fundingState === "awaiting-deposit" && f.claimsOpen === false && f.chainId === 84532));
  assert.ok(w.tasks.all().every((t) => !t.funded && t.payment.state === "NotRequested"));
  assert.equal(w.chain.calls.filter((c) => /release|transfer|withdraw|deposit/.test(c.method)).length, 0, "no fund movement on read or create");
  assert.equal(w.gh.issues.length, 0, "issues are only published after funding");
  // A developer cannot read the creator's funding instructions.
  const ada = await w.login("ada");
  assert.equal((await w.call("GET", `/api/agent/v1/funding?bounty=${w.portalStore.all()[0]!.id}`, { bearer: ada })).error.code, "not_found");
  await w.close();
});

test("search filters only on recorded facts; detail shows terms, release conditions and blockers; no private data", async () => {
  const w = await agentWorld();
  const owner = await w.login("owner");
  const ada = await w.login("ada");
  await w.bounty(owner, { rewardUsdc: "60", delivery: { hours: 12 }, title: "TypeScript parser fix" });
  await w.bounty(owner, { rewardUsdc: "40", delivery: { hours: 12 }, title: "TypeScript docs" });
  await w.bounty(owner, { rewardUsdc: "80", delivery: { days: 3 }, title: "TypeScript refactor" });
  const r = (await w.call("GET", "/api/agent/v1/bounties?q=typescript&minReward=50&maxDeliveryHours=24&status=available", { bearer: ada })).data;
  assert.deepEqual(r.bounties.map((b: any) => b.title), ["TypeScript parser fix"]);
  assert.match(r.unsupportedFilters, /not recorded/);
  assert.equal((await w.call("GET", "/api/agent/v1/bounties?minReward=1.234", { bearer: ada })).error.code, "invalid_input");
  assert.equal((await w.call("GET", "/api/agent/v1/bounties?limit=500", { bearer: ada })).error.code, "invalid_input");
  const d = (await w.call("GET", `/api/agent/v1/bounties/${r.bounties[0].code}`, { bearer: ada })).data;
  assert.equal(d.reward.amount, "60.00");
  assert.equal(d.reward.units, "60000000");
  assert.equal(d.reward.chainId, 84532);
  assert.match(d.agreement.hash, /^[a-f0-9]{64}$/);
  assert.equal(d.delivery.hours, 12);
  assert.match(d.releaseConditions.mergeBy, /@acme-owner/);
  assert.equal(d.releaseConditions.requiredChecks[0].job, "acceptance");
  const text = JSON.stringify(d);
  for (const secret of ["gho_", "iban", "clientSecret", "deviceCode"]) assert.ok(!text.includes(secret), secret);
  await w.close();
});
