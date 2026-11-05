// Fixed price + delivery deadline + exclusive assignment, on BOTH payment rails (bank and USDC),
// through the common lifecycle, the real rail adapters and a simulated escrow chain that models
// the contracts. Controlled clocks; temporary databases; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../server/tasks/store.ts";
import { TaskService } from "../server/tasks/service.ts";
import { GitHub } from "../server/tasks/github.ts";
import { SimulatedPayments } from "../server/tasks/payments.ts";
import { PortalStore, type Bounty, type User } from "../server/portal/store.ts";
import { MarketStore } from "../server/portal/market-store.ts";
import { MARKET_RELAY_GRACE_MS } from "../server/portal/market.ts";
import { FixedBounties } from "../server/market/fixed.ts";
import { simEscrows } from "../server/market/sim-chain.ts";
import type { Verdict } from "../server/tasks/domain.ts";

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 5, 9, 0, 0);
const HEAD = "a".repeat(40); // fixture evidence head
const owner: User = { id: 300, login: "client", name: "Client", avatar: "", token: "owner-token", createdAt: "" };
const alice: User = { id: 201, login: "alice", name: "Alice", avatar: "", token: "alice-token", createdAt: "" };
const bob: User = { id: 202, login: "bob", name: "Bob", avatar: "", token: "bob-token", createdAt: "" };
const iban = { firstName: "Alice", lastName: "Dev", iban: "FR1420041010050500013M02606", country: "FR" };
const wallet = (n: number) => "0x" + String(n).repeat(40).slice(0, 40);

type Rail = "bank" | "base-usdc";
const KEY = randomBytes(32); // stable across simulated restarts
function world(rail: Rail, path = ":memory:") {
  const clock = { now: T0, chainSkew: 0 };
  const tasks = new TaskStore(path);
  const portalStore = new PortalStore(tasks.db, "", KEY);
  const markets = new MarketStore(tasks.db, portalStore);
  const escrows = simEscrows(tasks.db, { now: () => clock.now + clock.chainSkew });
  const chain = rail === "bank" ? escrows.bank : escrows.usdc;
  const payments = new SimulatedPayments(tasks, escrows);
  const service = new TaskService(tasks, new GitHub({}), payments, { mode: "simulation", githubMode: "fixture", verifier: "sim-verifier", recipient: "r" });
  const prs = new Map<number, any>();
  const github = { get: async <T>(path: string) => {
    const n = Number(/\/pulls\/(\d+)$/.exec(path)?.[1]);
    if (!prs.has(n)) throw new Error("GitHub read failed (404)");
    return structuredClone(prs.get(n)) as T;
  } };
  const fixed = new FixedBounties({ markets, tasks: service, rail: async (t) => payments.market(t), ownerGitHub: () => github, environment: "simulation", now: () => clock.now });
  service.lifecycle = fixed;
  return { clock, tasks, portalStore, markets, chain, payments, service, fixed, prs, rail };
}
type World = ReturnType<typeof world>;

async function bounty(w: World, deliveryHours = 24): Promise<Bounty> {
  const id = crypto.randomUUID(), code = "NP-" + randomBytes(5).toString("hex").toUpperCase();
  const created = await w.service.create(
    { title: "CSV export", criteria: "Pass the acceptance tests", amountCents: 5000, repository: "client/repo", ...(w.rail === "base-usdc" ? { paymentRail: "base-usdc", refundAddress: "0x" + "c1ea2".repeat(8) } : {}) },
    { openBounty: true, ownerId: owner.id, portalId: id, portalCode: code, market: { kind: "fixed", deliveryHours } },
  );
  const b = { id, code, ownerId: owner.id, owner: owner.login, repository: "client/repo", private: false, title: "CSV export", description: "d", criteria: ["c"], amountCents: 5000, ...(w.rail === "base-usdc" ? { paymentRail: "base-usdc" as const } : {}), marketTerms: { version: 1, kind: "fixed", budgetCents: 5000, deliveryHours, biddingHours: 0, confirmationHours: 0 }, branch: "main", checkName: "acceptance", checkAppId: 15368, workflowPath: ".github/workflows/acceptance.yml", protectedPaths: "package.json", taskId: created.task.id, issueNumber: 1, issueUrl: null, status: "Open", published: true, error: null, createdAt: "", updatedAt: "" } as Bounty;
  w.portalStore.save(b);
  w.fixed.ensureMarket(b, w.tasks.get(b.taskId!));
  const t = w.tasks.get(b.taskId!);
  w.service.accept(t, "client", t.policyHash);
  return b;
}
async function pass(w: World, b: Bounty, times = 1) {
  for (let i = 0; i < times; i++) {
    w.tasks.enqueue(b.taskId!);
    await w.service.tick();
  }
}
async function fund(w: World, b: Bounty) {
  await pass(w, b); // configures the deadline terms on the escrow before funding
  w.service.fund(w.tasks.get(b.taskId!));
  await pass(w, b);
}
const destination = (w: World, user: User) => (w.rail === "base-usdc" ? { kind: "usdc" as const, address: wallet(user.id % 9 || 7), proofVersion: "proof-" + user.id } : { kind: "bank" as const, payout: iban, payoutVersion: "v-" + user.id });
function claim(w: World, b: Bounty, user: User, accepted = w.markets.get(b.id).policyHash) {
  return w.service.exclusive(`task:${b.taskId}`, () => w.fixed.claim(b, user, { acceptedPolicyHash: accepted }, destination(w, user), true));
}
function pr(w: World, n: number, user: User, marker: string, patch: Record<string, unknown> = {}) {
  w.prs.set(n, { number: n, user: { id: user.id }, base: { ref: "main", repo: { id: w.tasks.get(w.portalStore.all()[0]!.taskId!).policy.repositoryId } }, head: { sha: HEAD }, body: `Implements it.\n\nNearPortal-Task: ${marker}`, state: "open", merged: false, changed_files: 3, additions: 40, deletions: 2, created_at: new Date(w.clock.now).toISOString(), ...patch });
}
const submit = (w: World, b: Bounty, user: User, n: number, extra: Record<string, unknown> = {}) => w.service.exclusive(`task:${b.taskId}`, () => w.fixed.submit(b, user, { prNumber: n, ...extra }));
const market = (w: World, b: Bounty) => w.markets.get(b.id);
const calls = (w: World, method: string) => w.chain.calls.filter((c) => c.method === method).length;

for (const rail of ["bank", "base-usdc"] as Rail[]) {
  const R = rail === "bank" ? "[bank]" : "[usdc]";

  test(`${R} funding is required before a claim; terms are on the escrow before funding`, async () => {
    const w = world(rail);
    const b = await bounty(w);
    await pass(w, b);
    assert.equal(calls(w, "create_bounty"), 1);
    await assert.rejects(claim(w, b, alice), /not funded/);
    w.service.fund(w.tasks.get(b.taskId!));
    await pass(w, b);
    assert.equal(market(w, b).phase, "available");
  });

  test(`${R} two simultaneous claims: exactly one winner; owner cannot claim`, async () => {
    const w = world(rail);
    const b = await bounty(w);
    await fund(w, b);
    await assert.rejects(claim(w, b, owner), /owner|client/i);
    const results = await Promise.allSettled([claim(w, b, alice), claim(w, b, bob)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const t = w.tasks.get(b.taskId!);
    assert.ok([alice.id, bob.id].includes(t.policy.developerId));
    assert.equal(t.policy.assignment?.marker, `${b.code}-A1`);
  });

  test(`${R} delivery starts at the authoritative confirmation, not at the claim`, async () => {
    const w = world(rail);
    const b = await bounty(w);
    await fund(w, b);
    await claim(w, b, alice);
    assert.equal(w.fixed.view(b, alice.id)!.assignment!.confirmed, false);
    assert.equal(w.fixed.view(b, alice.id)!.assignment!.deadline, null, "no deadline shown while processing");
    pr(w, 7, alice, `${b.code}-A1`);
    await assert.rejects(submit(w, b, alice, 7), /still being confirmed/);
    w.chain.faults.push({ method: "assign_developer", when: "before" });
    w.clock.now += 40 * 60_000; // provider delay
    await pass(w, b).catch(() => {});
    assert.equal(market(w, b).assignment!.confirmedAt, null);
    w.clock.now += 20 * 60_000;
    await pass(w, b); // bind accepted at chain time T0 + 1h
    await pass(w, b); // read back and confirm
    const a = market(w, b).assignment!;
    assert.equal(a.acceptedAt, T0 + H);
    assert.equal(a.deadline, T0 + H + 24 * H);
    assert.equal(w.markets.activity({ bountyId: b.id })[0]!.kind, "assignment-confirmed");
  });

  test(`${R} submission at the deadline is timely; one millisecond later is refused`, async () => {
    for (const late of [false, true]) {
      const w = world(rail);
      const b = await bounty(w);
      await fund(w, b);
      await claim(w, b, alice);
      await pass(w, b, 2);
      const due = market(w, b).assignment!.deadline;
      w.clock.now = due + (late ? 1 : 0);
      pr(w, 7, alice, `${b.code}-A1`, { created_at: new Date(T0 + 1000).toISOString() });
      if (late) await assert.rejects(submit(w, b, alice, 7), /deadline has passed/);
      else assert.equal((await submit(w, b, alice, 7)).phase, "in-review");
    }
  });

  test(`${R} forged timestamps carry no authority; old or wrong PRs do not reserve the bounty`, async () => {
    const w = world(rail);
    const b = await bounty(w);
    await fund(w, b);
    await claim(w, b, alice);
    await pass(w, b, 2);
    const due = market(w, b).assignment!.deadline;
    w.clock.now = due + 5 * 60_000; // late, whatever the PR claims about its commits
    pr(w, 7, alice, `${b.code}-A1`, { head: { sha: HEAD, committed_at: new Date(T0).toISOString() }, updated_at: new Date(T0).toISOString() });
    await assert.rejects(submit(w, b, alice, 7), /deadline/);
    w.clock.now = due - H;
    pr(w, 8, alice, `${b.code}-A1`, { created_at: new Date(T0 - 10 * H).toISOString() });
    await assert.rejects(submit(w, b, alice, 8), /earlier pull requests cannot be reused/);
    pr(w, 9, alice, `${b.code}-A1`, { changed_files: 0, additions: 0, deletions: 0 });
    await assert.rejects(submit(w, b, alice, 9), /no changes/);
    pr(w, 10, alice, b.code);
    await assert.rejects(submit(w, b, alice, 10), /NearPortal-Task: .*-A1/);
    pr(w, 11, bob, `${b.code}-A1`);
    await assert.rejects(submit(w, b, alice, 11), /assigned developer/);
    pr(w, 12, alice, `${b.code}-A1`, { base: { ref: "other", repo: { id: 0 } } });
    await assert.rejects(submit(w, b, alice, 12), /target/);
    await assert.rejects(submit(w, b, bob, 7), /Only the assigned developer/);
    assert.equal(market(w, b).phase, "in-progress", "nothing above reserved or submitted anything");
  });

  test(`${R} a timely submission relayed later is kept; relay never extends development time`, async () => {
    const w = world(rail);
    const b = await bounty(w);
    await fund(w, b);
    await claim(w, b, alice);
    await pass(w, b, 2);
    const due = market(w, b).assignment!.deadline;
    w.clock.now = due;
    pr(w, 7, alice, `${b.code}-A1`, { created_at: new Date(due - H).toISOString() });
    await submit(w, b, alice, 7);
    w.chain.faults.push({ method: "record_submission", when: "before" });
    w.clock.now = due + 2 * 60_000;
    await pass(w, b).catch(() => {});
    w.clock.now = due + 10 * 60_000; // within grace
    await pass(w, b);
    assert.ok(w.tasks.get(b.taskId!).marketSubmission!.relayedAt);
    w.clock.now = due + 200 * H; // review much later: the submission never expires
    await pass(w, b);
    assert.equal(market(w, b).phase, "in-review");
  });

  test(`${R} expiry without a timely submission reopens with a new generation and moves no funds`, async () => {
    const w = world(rail);
    const b = await bounty(w);
    await fund(w, b);
    await claim(w, b, alice);
    await pass(w, b, 2);
    const due = market(w, b).assignment!.deadline;
    w.clock.now = due + MARKET_RELAY_GRACE_MS; // grace still open: no expiry
    await pass(w, b);
    assert.equal(market(w, b).phase, "in-progress");
    w.clock.now = due + MARKET_RELAY_GRACE_MS + 1;
    await pass(w, b);
    const m = market(w, b), t = w.tasks.get(b.taskId!);
    assert.equal(m.phase, "available");
    assert.equal(m.history[0]!.reason, "expired");
    assert.equal(t.policy.developerId, 0);
    assert.equal(t.funded, true, "funds stay secured");
    assert.equal(t.payment.state, "NotRequested", "no refund, no transfer");
    assert.equal(calls(w, "settle_bounty"), 0);
    assert.equal(w.markets.activity({ bountyId: b.id }).find((e) => e.kind === "assignment-expired")!.cause, "deadline");
    // Next claim: a fresh generation, marker and full window; the old marker is refused.
    w.clock.now += H;
    await claim(w, b, bob);
    await pass(w, b, 2);
    const a2 = market(w, b).assignment!;
    assert.equal(a2.marker, `${b.code}-A2`);
    assert.equal(a2.deadline - a2.acceptedAt, 24 * H);
    pr(w, 20, bob, `${b.code}-A1`);
    await assert.rejects(submit(w, b, bob, 20), /-A2/);
    pr(w, 21, alice, `${b.code}-A2`);
    await assert.rejects(submit(w, b, alice, 21), /Only the assigned developer/);
  });

  test(`${R} checks pending → failing → passing; payment after a late client merge, exactly once`, async () => {
    const w = world(rail);
    const b = await bounty(w);
    await fund(w, b);
    await claim(w, b, alice);
    await pass(w, b, 2);
    pr(w, 7, alice, `${b.code}-A1`);
    await submit(w, b, alice, 7);
    await pass(w, b); // relay
    w.service.simulate(w.tasks.get(b.taskId!), "failed", "developer");
    await pass(w, b);
    assert.equal(w.tasks.get(b.taskId!).verdict?.status, "blocked");
    assert.equal(w.tasks.get(b.taskId!).payment.state, "NotRequested");
    w.service.simulate(w.tasks.get(b.taskId!), "ready", "developer");
    await pass(w, b);
    assert.equal(w.tasks.get(b.taskId!).verdict?.status, "pending", "passing checks are not a payment");
    w.clock.now = market(w, b).assignment!.deadline + 72 * H; // client merges three days late
    w.service.simulate(w.tasks.get(b.taskId!), "merged", "client");
    await pass(w, b);
    await pass(w, b);
    const t = w.tasks.get(b.taskId!);
    assert.equal(t.payment.state, "Processed");
    assert.equal(market(w, b).phase, "paid");
    await pass(w, b, 3); // duplicate events after payment
    assert.equal((w.tasks.db.prepare("SELECT COUNT(*) AS n FROM releases").get() as { n: number }).n, 1);
    assert.equal(calls(w, "settle_bounty"), 1);
    assert.deepEqual(w.markets.activity({ userId: alice.id }).map((e) => e.kind), ["assignment-confirmed", "submission-received", "payment-confirmed"]);
  });

  test(`${R} withdrawal clears the escrow first, then reopens`, async () => {
    const w = world(rail);
    const b = await bounty(w);
    await fund(w, b);
    await claim(w, b, alice);
    await pass(w, b, 2);
    const g = market(w, b).assignment!.generation;
    assert.throws(() => w.fixed.requestWithdraw(b, bob, { generation: g }), /Only the assigned developer/);
    w.fixed.requestWithdraw(b, alice, { generation: g });
    assert.equal(market(w, b).phase, "in-progress", "not reopened before the chain is cleared");
    await pass(w, b);
    assert.equal(market(w, b).phase, "available");
    assert.equal(w.markets.activity({ bountyId: b.id }).at(-1)!.kind, "assignment-withdrawn");
  });

  test(`${R} a dispute pauses expiry, reassignment and release`, async () => {
    const w = world(rail);
    const b = await bounty(w);
    await fund(w, b);
    await claim(w, b, alice);
    await pass(w, b, 2);
    await w.service.exclusive(`task:${b.taskId}`, async () => {
      await w.service.dispute(w.tasks.get(b.taskId!), "client");
      w.markets.applyLatest(b.id, { type: "pause" }, w.clock.now);
    });
    w.clock.now += 100 * H;
    await pass(w, b);
    assert.equal(market(w, b).phase, "paused");
    assert.equal(market(w, b).assignment!.userId, alice.id, "no silent reassignment");
    assert.equal(calls(w, "expire_assignment"), 0);
  });

  test(`${R} restarts at every step resume without duplicate binding or payment`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "np-fixed-"));
    try {
      const path = join(dir, "db.sqlite");
      let w = world(rail, path);
      const b = await bounty(w);
      await fund(w, b);
      await claim(w, b, alice); // crash right after the claim committed
      const restart = () => {
        const { clock } = w;
        w.tasks.close();
        const next = world(rail, path);
        next.clock.now = clock.now;
        next.chain.calls = w.chain.calls;
        next.prs.clear();
        for (const [k, v] of w.prs) next.prs.set(k, v);
        w = next;
      };
      restart();
      const bindMethod = "assign_developer";
      w.chain.faults.push({ method: bindMethod, when: "after" }); // bound on chain, outcome unknown locally
      await pass(w, b).catch(() => {});
      restart();
      await pass(w, b);
      assert.ok(market(w, b).assignment!.confirmedAt, "confirmed from the chain after restart");
      assert.equal(calls(w, bindMethod), 1, "never bound twice");
      pr(w, 7, alice, `${b.code}-A1`);
      await submit(w, b, alice, 7); // crash before relay
      restart();
      await pass(w, b);
      assert.ok(w.tasks.get(b.taskId!).marketSubmission!.relayedAt);
      w.service.simulate(w.tasks.get(b.taskId!), "ready", "developer");
      w.service.simulate(w.tasks.get(b.taskId!), "merged", "client");
      const releaseMethod = "settle_bounty";
      w.chain.faults.push({ method: releaseMethod, when: "after" }); // broadcast, crash before local record
      await pass(w, b).catch(() => {});
      assert.equal(w.tasks.get(b.taskId!).payment.state, "Authorized");
      restart();
      await pass(w, b, 2);
      assert.equal(w.tasks.get(b.taskId!).payment.state, "Processed");
      assert.equal(calls(w, releaseMethod), 1, "reconciled, not re-sent");
      w.tasks.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${R} restart during expiry: chain cleared, engine catches up; no double expiry`, async () => {
    const w = world(rail);
    const b = await bounty(w);
    await fund(w, b);
    await claim(w, b, alice);
    await pass(w, b, 2);
    w.clock.now = market(w, b).assignment!.deadline + MARKET_RELAY_GRACE_MS + 1;
    const method = "expire_assignment";
    w.chain.faults.push({ method, when: "after" });
    await pass(w, b);
    assert.equal(market(w, b).phase, "available", "uncertain chain expiry is re-read and completed");
    assert.equal(calls(w, method), 1);
  });

  test(`${R} restart AFTER chain expiry before local commit reconciles the cleared generation`, async () => {
    const w = world(rail), b = await bounty(w);
    await fund(w, b); await claim(w, b, alice); await pass(w, b, 2);
    const t = w.tasks.get(b.taskId!);
    w.clock.now = market(w, b).assignment!.deadline + MARKET_RELAY_GRACE_MS + 1;
    const adapter = (await w.payments.market(t))!;
    await adapter.expire(t, 1); // process stops before committing the engine transition
    assert.equal(market(w, b).phase, "in-progress");
    await w.fixed.step(w.tasks.get(t.id));
    assert.equal(market(w, b).phase, "available");
    assert.equal(w.tasks.get(t.id).funded, true);
    assert.equal(calls(w, "expire_assignment"), 1);
    await claim(w, b, bob); await pass(w, b, 2);
    assert.equal(market(w, b).assignment!.generation, 2);
  });

  test(`${R} restart AFTER chain withdrawal before local commit reopens safely`, async () => {
    const w = world(rail), b = await bounty(w);
    await fund(w, b); await claim(w, b, alice); await pass(w, b, 2);
    w.fixed.requestWithdraw(b, alice, { generation: 1 });
    const t = w.tasks.get(b.taskId!);
    await (await w.payments.market(t))!.withdraw(t, 1);
    await w.fixed.step(w.tasks.get(t.id));
    assert.equal(market(w, b).phase, "available");
    assert.equal(market(w, b).history.at(-1)!.reason, "withdrawn");
    assert.equal(w.tasks.get(t.id).funded, true);
  });

  test(`${R} stale revisions, duplicate commands and an old copy cannot overwrite newer state`, async () => {
    const w = world(rail);
    const b = await bounty(w);
    await fund(w, b);
    const rev = market(w, b).revision;
    await w.service.exclusive(`task:${b.taskId}`, () => w.fixed.claim(b, alice, { acceptedPolicyHash: market(w, b).policyHash, expectedRevision: rev }, destination(w, alice), true));
    await assert.rejects(w.service.exclusive(`task:${b.taskId}`, () => w.fixed.claim(b, alice, { acceptedPolicyHash: market(w, b).policyHash, expectedRevision: rev }, destination(w, alice), true)), /changed|already/);
    await pass(w, b, 2);
    pr(w, 7, alice, `${b.code}-A1`);
    const first = await submit(w, b, alice, 7);
    const again = await submit(w, b, alice, 7);
    assert.equal(again.assignment!.submission!.receivedAt, first.assignment!.submission!.receivedAt, "same head: no new reception time");
    await assert.rejects(submit(w, b, alice, 7, { expectedRevision: rev }), /changed/);
    await assert.rejects(claim(w, b, bob, "f".repeat(64)), /not available|Terms changed/);
  });
}

test("release gate: the paid head must be the exact submitted head of the current generation", () => {
  const w = world("bank");
  const fake = (headSha: string, status: Verdict["status"] = "eligible"): Verdict => ({ status, reasons: [], evidenceHash: "x" } as Verdict);
  const t = { portalId: "missing", marketSubmission: null } as never;
  const v = fake(HEAD);
  w.fixed.gate(t, { prNumber: 1, headSha: HEAD } as never, v);
  assert.equal(v.status, "pending", "no registered submission: never eligible");
});

test("bank and USDC differ only in adapter calls and destinations", async () => {
  for (const rail of ["bank", "base-usdc"] as Rail[]) {
    const w = world(rail);
    const b = await bounty(w);
    await fund(w, b);
    await claim(w, b, alice);
    const t = w.tasks.get(b.taskId!);
    if (rail === "bank") {
      assert.match(t.policy.recipient, /…|\.\.\./);
      assert.equal(t.policy.paymentRail, undefined);
    } else {
      assert.match(t.policy.recipient, /^0x[0-9a-f]{40}$/);
    }
    await assert.rejects(w.service.exclusive(`task:${b.taskId}`, async () => w.service.assign(w.tasks.get(b.taskId!), bob, rail === "bank" ? { kind: "usdc", address: wallet(3) } : { kind: "bank", payout: iban }, { generation: 9, marker: "x" })), /not available|USDC|bank/);
  }
});

test("[usdc] an outage beyond the common relay grace preserves evidence but cannot authorize payment", async () => {
  const w = world("base-usdc"), b = await bounty(w);
  await fund(w, b); await claim(w, b, alice); await pass(w, b, 2);
  const due = market(w, b).assignment!.deadline;
  w.clock.now = due; pr(w, 7, alice, `${b.code}-A1`, { created_at: new Date(due - H).toISOString() });
  await submit(w, b, alice, 7);
  w.clock.now = due + 72 * H;
  await pass(w, b);
  assert.equal(w.tasks.get(b.taskId!).marketSubmission!.relayedAt, null);
  assert.equal(market(w, b).phase, "in-review");
  assert.equal(calls(w, "settle_bounty"), 0);
  assert.equal(calls(w, "expire_assignment"), 0);
  assert.match(w.tasks.get(b.taskId!).payment.error ?? "", /relay window/);
  assert.equal(w.tasks.get(b.taskId!).marketSubmission!.receivedAt, due);
});


test('[usdc] a refund wallet cannot reserve an exclusive developer assignment',async()=>{
 const w=world('base-usdc');const b=await bounty(w);await fund(w,b);
 const refund=w.tasks.get(b.taskId!).policy.refundAddress!;
 await assert.rejects(w.service.exclusive(`task:${b.taskId}`,()=>w.fixed.claim(b,alice,{acceptedPolicyHash:market(w,b).policyHash},{kind:'usdc',address:refund,proofVersion:'verified'},true)),/payout address/);
 assert.equal(market(w,b).phase,'available');assert.equal(market(w,b).assignment,null);
 assert.equal(w.tasks.get(b.taskId!).policy.developerId,0);
 await claim(w,b,alice);await pass(w,b,2);
 assert.ok(market(w,b).assignment!.confirmedAt);
});
