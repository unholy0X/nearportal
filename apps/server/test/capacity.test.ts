// Capacity, concurrency, crash-recovery and provider-failure tests for the hosted testnet demo.
// Everything here is isolated: temporary databases, simulated payment adapter, mocked GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { TaskStore, StaleWriteError } from "../server/tasks/store.ts";
import { TaskService } from "../server/tasks/service.ts";
import { GitHub } from "../server/tasks/github.ts";
import type { PaymentAdapter } from "../server/tasks/payments.ts";
import type { Task } from "../server/tasks/domain.ts";
import { RateLimiter, makeClientIp, trustedProxies, categorize, defaultRules } from "../server/portal/rate-limit.ts";
import { ProviderGate, ProviderFailure, ProviderUnavailable, backoff, retryAfterMs } from "../server/ops/provider.ts";
import { PortalStore, StaleBountyError, type Bounty } from "../server/portal/store.ts";
import { ReadModel } from "../server/portal/read-model.ts";
import { webhookTargets } from "../server/tasks/http.ts";
import { backup } from "../scripts/backup.ts";
import { restoreCheck } from "../scripts/restore-check.ts";
import { PaymentPending } from "../server/tasks/payment-pending.ts";
import { redact } from "../server/ops/log.ts";
import { hostedConfig } from "../server/ops/hosted.ts";

const config = { mode: "simulation", githubMode: "fixture", verifier: "demo-verifier", recipient: "demo-developer" } as const;
const bank = { firstName: "Demo", lastName: "Developer", iban: "FR1420041010050500013M02606", country: "FR" };
const input = { title: "CSV export", criteria: "Escape commas\nPass acceptance tests", amountCents: 10_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

/** A payment rail with on-chain state that survives "restarts" of the service. */
class ChainSim implements PaymentAdapter {
  broadcasts = 0;
  chain = new Map<string, "Signing" | "Processed">();
  crash: "before-broadcast" | "after-broadcast" | null = null;
  prepareGate = new Map<string, Promise<void>>();
  async prepare(t: Task) {
    await this.prepareGate.get(t.id);
  }
  async sync(t: Task) {
    const payout = this.chain.get(t.id);
    if (payout) t.payment = { state: payout, reference: `sim:${t.id}`, error: null };
  }
  async release(t: Task) {
    if (this.crash === "before-broadcast") {
      this.crash = null;
      throw new Error("process killed before broadcast");
    }
    this.broadcasts++;
    this.chain.set(t.id, "Signing");
    if (this.crash === "after-broadcast") {
      this.crash = null;
      throw new Error("connection reset: transaction outcome unknown");
    }
    t.payment = { state: "Signing", reference: `sim:${t.id}`, error: null };
  }
  async dispute() {}
  async deposit(t: Task) {
    return { iban: null, reference: t.id };
  }
}

function service(store: TaskStore, payments: PaymentAdapter) {
  return new TaskService(store, new GitHub({}), payments, config);
}
async function ready(s: TaskService) {
  const created = await s.create(input);
  let t = s.store.get(created.task.id);
  s.setPayout(t, "developer", bank);
  t = s.store.get(t.id);
  s.accept(t, "client", t.policyHash);
  t = s.store.get(t.id);
  s.accept(t, "developer", t.policyHash);
  s.fund(s.store.get(t.id));
  s.bindPr(s.store.get(t.id), 7);
  s.simulate(s.store.get(t.id), "ready", "developer");
  return s.store.get(t.id);
}
const merge = (s: TaskService, id: string) => s.simulate(s.store.get(id), "merged", "client");
const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "np-capacity-"));
  return { dir, path: join(dir, "tasks.sqlite"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

// ---------- Concurrency and revisions ----------

test("a save from a stale copy is refused instead of overwriting newer state", async () => {
  const store = new TaskStore(":memory:");
  const s = service(store, new ChainSim());
  const t = await ready(s);
  const a = store.get(t.id), b = store.get(t.id);
  a.disputed = true;
  store.save(a);
  b.payment.error = "old copy";
  assert.throws(() => store.save(b), StaleWriteError);
  assert.equal(store.get(t.id).disputed, true, "the dispute survives");
});

test("two simultaneous claims of an open bounty: exactly one wins", async () => {
  const store = new TaskStore(":memory:");
  const s = service(store, new ChainSim());
  const created = await s.create(input, { openBounty: true, ownerId: 1 });
  let t = store.get(created.task.id);
  s.accept(t, "client", t.policyHash);
  s.fund(store.get(t.id));
  const hash = store.get(t.id).policyHash;
  const claim = (id: number) => s.exclusive(`task:${t.id}`, () => s.claim(store.get(t.id), { id, login: `dev${id}` }, bank, hash));
  const results = await Promise.allSettled([claim(201), claim(202), claim(203)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  t = store.get(t.id);
  assert.ok([201, 202, 203].includes(t.policy.developerId));
});

test("a slow provider on bounty A does not block bounty B (no global lock)", async () => {
  const store = new TaskStore(":memory:");
  const sim = new ChainSim();
  const s = service(store, sim);
  const a = await ready(s), b = await ready(s);
  const hold = deferred();
  sim.prepareGate.set(a.id, hold.promise);
  const tickA = s.tick(); // A hangs in prepare; B's pass runs in another slot
  await sleep(20);
  merge(s, b.id);
  // An HTTP mutation on B completes while A is still stuck.
  const started = Date.now();
  await s.exclusive(`task:${b.id}`, () => s.store.enqueue(b.id));
  assert.ok(Date.now() - started < 100, "B's lock is independent from A's");
  await s.tick();
  assert.equal(store.get(b.id).payment.state, "Signing", "B advanced while A was blocked");
  assert.equal(sim.broadcasts, 1);
  hold.resolve();
  await tickA;
});

test("a permanently stuck task occupies one slot only; the queue keeps moving", async () => {
  const store = new TaskStore(":memory:");
  const sim = new ChainSim();
  const s = service(store, sim);
  const stuck = await ready(s);
  sim.prepareGate.set(stuck.id, new Promise(() => {})); // never resolves
  const others = [await ready(s), await ready(s), await ready(s)];
  others.forEach((t) => merge(s, t.id));
  void s.tick();
  for (let i = 0; i < 5; i++) {
    await sleep(20);
    await s.tick();
  }
  for (const t of others) assert.equal(store.get(t.id).payment.state, "Signing");
  assert.equal(s.busy, 1, "only the stuck task is still in flight");
});

test("double webhook and double refresh produce one payment broadcast", async () => {
  const store = new TaskStore(":memory:");
  const sim = new ChainSim();
  const s = service(store, sim);
  const t = await ready(s);
  merge(s, t.id);
  store.delivery("d-1", [t.id], "pull_request");
  assert.equal(store.delivery("d-1", [t.id], "pull_request"), false, "duplicate delivery ignored");
  store.enqueue(t.id);
  store.enqueue(t.id);
  await Promise.all([s.tick(), s.tick(), s.tick()]);
  await s.tick();
  assert.equal(sim.broadcasts, 1);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM releases WHERE task_id=?").get(t.id) as { n: number }).n, 1);
});

test("a dispute racing with verification never overwrites or follows a release", async () => {
  const store = new TaskStore(":memory:");
  const sim = new ChainSim();
  const s = service(store, sim);
  const t = await ready(s);
  merge(s, t.id);
  const hold = deferred();
  sim.prepareGate.set(t.id, hold.promise);
  const worker = s.tick();
  await sleep(10);
  const dispute = s.exclusive(`task:${t.id}`, () => s.dispute(store.get(t.id), "client"));
  hold.resolve();
  await worker;
  const outcome = await dispute.then(() => "disputed", (e: Error) => e.message);
  const final = store.get(t.id);
  // The worker held the task: it authorized first, so the dispute is refused, not lost.
  assert.match(String(outcome), /already authorized/);
  assert.equal(final.disputed, false);
  assert.equal(sim.broadcasts, 1);
});

test("an out-of-band write during a network wait is preserved (worker defers, no overwrite)", async () => {
  const store = new TaskStore(":memory:");
  const sim = new ChainSim();
  const s = service(store, sim);
  const t = await ready(s);
  const original = sim.sync.bind(sim);
  sim.sync = async (task) => {
    const other = store.get(task.id); // e.g. another component recording a note
    other.timeline.push({ at: new Date().toISOString(), message: "external update" } as Task["timeline"][number]);
    store.save(other);
    await original(task);
  };
  await s.tick();
  const final = store.get(t.id);
  assert.ok(final.timeline.some((e) => e.message === "external update"));
  const row = store.db.prepare("SELECT error FROM queue WHERE task_id=?").get(t.id) as { error: string };
  assert.match(row.error, /concurrent update/);
});

// ---------- Crash and restart ----------

for (const [label, crash, expectedBroadcasts] of [
  ["after authorization, before any payment call", "before-broadcast", 1],
  ["after broadcast, before the local record (outcome unknown)", "after-broadcast", 1],
] as const) {
  test(`restart ${label}: reconciles, pays exactly once`, async () => {
    const db = tempDb();
    try {
      const sim = new ChainSim();
      let store = new TaskStore(db.path);
      let s = service(store, sim);
      const t = await ready(s);
      merge(s, t.id);
      sim.crash = crash;
      await s.tick();
      assert.equal(store.get(t.id).payment.state, "Authorized", "authorization is durable before payment");
      store.close();
      // Process restart: new store and service on the same database; the chain kept its state.
      store = new TaskStore(db.path);
      s = service(store, sim);
      s.reconcile();
      store.enqueue(t.id);
      await s.tick();
      await s.tick();
      assert.equal(sim.broadcasts, expectedBroadcasts);
      assert.equal(store.get(t.id).payment.state, "Signing");
      sim.chain.set(t.id, "Processed");
      store.enqueue(t.id);
      await s.tick();
      assert.equal(store.get(t.id).payment.state, "Processed", "Paid only after the rail confirms");
      assert.equal(sim.broadcasts, expectedBroadcasts);
      store.close();
    } finally {
      db.cleanup();
    }
  });
}

test("restart after signing: an in-flight payment is resumed from the chain, not re-sent", async () => {
  const db = tempDb();
  try {
    const sim = new ChainSim();
    let store = new TaskStore(db.path);
    let s = service(store, sim);
    const t = await ready(s);
    merge(s, t.id);
    await s.tick();
    assert.equal(store.get(t.id).payment.state, "Signing");
    store.close();
    store = new TaskStore(db.path);
    s = service(store, sim);
    store.enqueue(t.id);
    await s.tick();
    assert.equal(sim.broadcasts, 1);
    store.close();
  } finally {
    db.cleanup();
  }
});

test("failure backoff grows, is not reset by reconciliation, and failing tasks yield the queue", async () => {
  const store = new TaskStore(":memory:");
  const sim = new ChainSim();
  sim.prepare = async () => {
    throw new Error("provider exploded");
  };
  const s = service(store, sim);
  const t = await ready(s);
  await s.tick();
  const first = store.db.prepare("SELECT attempts,next_at FROM queue WHERE task_id=?").get(t.id) as { attempts: number; next_at: number };
  assert.equal(first.attempts, 1);
  s.reconcile();
  const after = store.db.prepare("SELECT attempts,next_at FROM queue WHERE task_id=?").get(t.id) as { attempts: number; next_at: number };
  assert.deepEqual(after, first, "reconcile left the backoff alone");
  // Delays grow and stay bounded.
  const delays = [0, 1, 2, 3, 8, 20].map((n) => backoff(n, 20_000, 900_000, () => 1));
  assert.deepEqual(delays.slice(0, 4), [20_000, 40_000, 80_000, 160_000]);
  assert.equal(delays.at(-1), 900_000);
  // Ordering is by due time: a long-failing task does not hold the head of the queue.
  store.db.prepare("UPDATE queue SET next_at=? WHERE task_id=?").run(Date.now() - 1000, t.id);
  const fresh = await ready(s);
  store.db.prepare("UPDATE queue SET next_at=? WHERE task_id=?").run(Date.now() - 5000, fresh.id);
  assert.equal(store.due(1)[0], fresh.id);
});

test("a provider outage defers tasks without counting as their failure", async () => {
  const store = new TaskStore(":memory:");
  const sim = new ChainSim();
  sim.prepare = async () => {
    throw new ProviderUnavailable("near-rpc", Date.now() + 60_000, "circuit open");
  };
  const s = service(store, sim);
  const t = await ready(s);
  await s.tick();
  const row = store.db.prepare("SELECT attempts,next_at FROM queue WHERE task_id=?").get(t.id) as { attempts: number; next_at: number };
  assert.equal(row.attempts, 0);
  assert.ok(row.next_at >= Date.now() + 55_000);
  assert.equal(store.get(t.id).payment.state, "NotRequested", "an outage is never a validation");
});

// ---------- Webhooks ----------

test("webhooks wake only the affected tasks", () => {
  const base = { githubMode: "live", payment: { state: "NotRequested" }, disputed: false, funded: true } as const;
  const tasks = [
    { ...base, id: "a", prNumber: 7, policy: { repositoryId: 1, developerId: 5 }, evidence: { headSha: "s1" } },
    { ...base, id: "b", prNumber: 8, policy: { repositoryId: 1, developerId: 5 }, evidence: { headSha: "s2" } },
    { ...base, id: "c", prNumber: null, policy: { repositoryId: 1, developerId: 6 }, evidence: null },
    { ...base, id: "d", prNumber: 7, policy: { repositoryId: 2, developerId: 5 }, evidence: null },
  ] as unknown as Task[];
  assert.deepEqual(webhookTargets(tasks, "pull_request", { repository: { id: 1 }, number: 7 }), { taskIds: ["a"], discovery: ["c"] });
  assert.deepEqual(webhookTargets(tasks, "check_run", { repository: { id: 1 }, check_run: { head_sha: "s2", pull_requests: [] } }).taskIds, ["b"]);
  assert.deepEqual(webhookTargets(tasks, "push", { repository: { id: 1 } }).taskIds, ["a", "b"]);
  assert.deepEqual(webhookTargets(tasks, "issues", { repository: { id: 1 } }).taskIds, []);
  assert.deepEqual(webhookTargets(tasks, "ping", { repository: { id: 1 } }).taskIds, []);
});

// ---------- Rate limits and proxy headers ----------

const req = (remote: string, xff?: string) => ({ socket: { remoteAddress: remote }, headers: xff ? { "x-forwarded-for": xff } : {} }) as unknown as IncomingMessage;

test("100 users behind one proxy never share an action quota", () => {
  const limiter = new RateLimiter();
  for (let u = 0; u < 100; u++)
    for (let i = 0; i < 60; i++) assert.equal(limiter.take("mutation", `u${u}`).ok, true, `user ${u} action ${i}`);
  const over = limiter.take("mutation", "u0");
  assert.equal(over.ok, false);
  assert.ok(!over.ok && over.retryAfterSeconds >= 1 && over.retryAfterSeconds <= 60);
  assert.equal(limiter.take("mutation", "u1").ok, false);
  assert.equal(limiter.take("read", "u0").ok, true, "categories are separate");
});

test("forwarded headers are honoured only from trusted proxies and cannot be forged", () => {
  const ip = makeClientIp(trustedProxies("10.0.0.2,172.30.0.0/24"));
  assert.equal(ip(req("203.0.113.9", "1.2.3.4")), "203.0.113.9", "untrusted peer: header ignored");
  assert.equal(ip(req("10.0.0.2", "198.51.100.7")), "198.51.100.7");
  // A client prepends a forged hop; the proxy appends the real one. The right-most untrusted wins.
  assert.equal(ip(req("10.0.0.2", "6.6.6.6, 198.51.100.7")), "198.51.100.7");
  assert.equal(ip(req("10.0.0.2", "198.51.100.7, 172.30.0.5")), "198.51.100.7", "trusted inner hops skipped");
  assert.equal(ip(req("::ffff:10.0.0.2", "garbage")), "10.0.0.2", "malformed chain falls back to the peer");
  const none = makeClientIp(trustedProxies(""));
  assert.equal(none(req("10.0.0.2", "1.1.1.1")), "10.0.0.2");
  assert.throws(() => trustedProxies("not-an-ip"));
});

test("limiter memory is bounded and idle entries expire", () => {
  let now = 0;
  const limiter = new RateLimiter(defaultRules(), 1000, () => now);
  for (let i = 0; i < 5000; i++) limiter.take("anon-read", `ip${i}`);
  assert.ok(limiter.size <= 1000);
  now += 10 * 60_000;
  limiter.sweep();
  assert.equal(limiter.size, 0);
});

test("provider-backed reads and access checks have their own quotas", () => {
  assert.equal(categorize("GET", "/api/portal/repositories").category, "expensive-read");
  assert.equal(categorize("GET", "/api/portal/bounties/x/deposit").category, "expensive-read");
  assert.equal(categorize("POST", "/api/portal/bounties/x/refresh").category, "refresh");
  assert.equal(categorize("POST", "/api/portal/bounties/x/check-access").category, "access-check");
  assert.equal(categorize("POST", "/api/portal/bounties/x/wallet-challenge").category, "wallet");
  assert.equal(categorize("GET", "/auth/github").category, "auth");
  assert.equal(categorize("GET", "/api/portal/home").category, "read");
});

// ---------- Provider gate ----------

test("gate: circuit opens after repeated failures, refuses calls, then recovers via one probe", async () => {
  let now = 1_000_000;
  const g = new ProviderGate("test", { failureThreshold: 3, openMs: 10_000, hourlyBudget: 1000 }, () => now, false);
  let calls = 0;
  const failing = () => g.run(async () => { calls++; throw new ProviderFailure("503", undefined, 503); });
  for (let i = 0; i < 3; i++) await assert.rejects(failing());
  await assert.rejects(failing(), ProviderUnavailable);
  assert.equal(calls, 3, "no traffic while open");
  now += 200_000;
  assert.equal(await g.run(async () => { calls++; return "ok"; }), "ok");
  assert.equal(g.state().circuit, "closed");
});

test("gate: Retry-After pauses all calls; budget caps traffic; identical reads share one call", async () => {
  let now = 0;
  const g = new ProviderGate("test", { hourlyBudget: 5, failureThreshold: 100 }, () => now, false);
  await assert.rejects(g.run(async () => { throw new ProviderFailure("429", 30_000, 429); }));
  await assert.rejects(g.run(async () => "x"), (e: unknown) => e instanceof ProviderUnavailable && e.retryAt === 30_000);
  now = 31_000;
  let calls = 0;
  const shared = await Promise.all(Array.from({ length: 10 }, () => g.run(async () => { calls++; await sleep(5); return 1; }, { key: "same" })));
  assert.equal(calls, 1);
  assert.equal(shared.length, 10);
  for (let i = 0; i < 3; i++) await g.run(async () => 1);
  await assert.rejects(g.run(async () => 1), /budget/);
  assert.equal(retryAfterMs("120"), 120_000);
  assert.equal(retryAfterMs(new Date(Date.now() + 5000).toUTCString())! <= 5000, true);
});

test("gate: a hung read times out and frees its slot", async () => {
  const g = new ProviderGate("test", { timeoutMs: 50, concurrency: 1 }, undefined, false);
  await assert.rejects(g.run(() => new Promise(() => {})), /timed out/);
  assert.equal(await g.run(async () => "next"), "next");
});

// ---------- GitHub client ----------

function githubWith(handler: (path: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    calls.push(path);
    return handler(path, init);
  }) as typeof fetch;
  return { gh: new GitHub({ token: `t-${randomBytes(4).toString("hex")}` }, fetcher), calls };
}

test("GitHub: ETag revalidation, immutable SHA cache and request de-duplication", async () => {
  const sha = "a".repeat(40);
  const { gh, calls } = githubWith((path, init) => {
    const h = new Headers(init.headers);
    if (path.startsWith("/repos/o/r/pulls/1")) {
      if (h.get("if-none-match") === '"v1"') return new Response(null, { status: 304 });
      return new Response(JSON.stringify({ number: 1 }), { headers: { etag: '"v1"' } });
    }
    return new Response(JSON.stringify({ type: "file", sha: "blob" }));
  });
  await gh.get("/repos/o/r/pulls/1");
  assert.deepEqual(await gh.get("/repos/o/r/pulls/1"), { number: 1 }, "304 served from cache");
  const path = `/repos/o/r/contents/package.json?ref=${sha}`;
  await Promise.all([gh.get(path), gh.get(path), gh.get(path)]);
  await gh.get(path);
  assert.equal(calls.filter((c) => c === path).length, 1, "SHA-addressed content fetched once");
});

test("GitHub: 429/secondary limits pause the credential; 5xx retries are bounded; 401 clears cache", async () => {
  let mode = "limited", hits = 0;
  const { gh } = githubWith(() => {
    hits++;
    if (mode === "limited") return new Response("{}", { status: 429, headers: { "retry-after": "60" } });
    if (mode === "secondary") return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), { status: 403 });
    if (mode === "down") return new Response("{}", { status: 502 });
    if (mode === "revoked") return new Response("{}", { status: 401 });
    return new Response(JSON.stringify({ ok: true }), { headers: { etag: '"e"' } });
  });
  await assert.rejects(gh.get("/user"), /rate limit/);
  await assert.rejects(gh.get("/user"), ProviderUnavailable);
  assert.equal(hits, 1, "paused credential sends nothing");

  const { gh: gh2 } = githubWith(() => new Response(JSON.stringify({ message: "secondary rate limit" }), { status: 403 }));
  await assert.rejects(gh2.get("/user"), /rate limit/);
  await assert.rejects(gh2.get("/user"), ProviderUnavailable);

  let fiveHits = 0;
  const { gh: gh3 } = githubWith(() => { fiveHits++; return new Response("{}", { status: 503 }); });
  await assert.rejects(gh3.get("/user"), /503/);
  assert.equal(fiveHits, 3, "two bounded retries, no aggressive loop");

  mode = "ok";
  const { gh: gh4 } = githubWith(() => (mode === "revoked" ? new Response("{}", { status: 401 }) : new Response(JSON.stringify({ ok: true }), { headers: { etag: '"e"' } })));
  await gh4.get("/user");
  mode = "revoked";
  await assert.rejects(gh4.get("/user"), /\(401\)/);
  mode = "ok";
  assert.deepEqual(await gh4.get("/user"), { ok: true }, "service resumes after the credential is renewed");
});

test("GitHub: primary quota reserve pauses before exhaustion", async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  let hits = 0;
  const { gh } = githubWith(() => { hits++; return new Response("{}", { headers: { "x-ratelimit-remaining": "3", "x-ratelimit-reset": String(reset) } }); });
  await gh.get("/a");
  await assert.rejects(gh.get("/b"), ProviderUnavailable);
  assert.equal(hits, 1);
});

// ---------- Read model, pagination and privacy ----------

function readModelFixture(n: number) {
  const tasks = new TaskStore(":memory:");
  const store = new PortalStore(tasks.db, "", randomBytes(32));
  for (let i = 0; i < n; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const t = { id: `t${i}`, funded: i % 3 !== 0, disputed: false, prNumber: i % 5 === 0 ? 3 : null, verdict: null, payment: { state: i % 7 === 0 ? "Processed" : "NotRequested" }, policy: { developerId: i % 2 ? 900 + (i % 4) : 0, developerLogin: i % 2 ? "dev" : "Unclaimed" } };
    tasks.db.prepare("INSERT INTO tasks(id,body) VALUES(?,?)").run(t.id, JSON.stringify(t));
    store.save({ id, code: `NP-${String(i).padStart(10, "0")}`, ownerId: i % 10 === 0 ? 1 : 2, owner: "o", repository: `o/r${i % 4}`, private: i % 9 === 0, title: `Bounty ${i}`, description: "", criteria: [], amountCents: 100, branch: "main", checkName: "a", checkAppId: 1, workflowPath: "w", protectedPaths: "", taskId: t.id, issueNumber: null, issueUrl: null, status: "Open", published: i % 11 !== 0, error: null, createdAt: new Date(2026, 0, 1, 0, i).toISOString(), updatedAt: "" } as Bounty);
  }
  return { tasks, store, reads: new ReadModel(store, tasks, {}) };
}

test("lists are paginated, bounded and filtered on the server", () => {
  const { reads } = readModelFixture(1000);
  const all = reads.page({ scope: "explore", limit: 500 }, () => true);
  assert.equal(all.limit, 100, "page size is capped");
  assert.equal(all.items.length, 100);
  assert.equal(all.total, 1000 - Math.ceil(1000 / 11));
  const mine = reads.page({ scope: "mine", userId: 1 }, () => true);
  assert.ok(mine.items.every((b) => b.ownerId === 1));
  const paid = reads.page({ scope: "explore", status: "paid" }, () => true);
  assert.ok(paid.total > 0 && paid.total === all.counts.paid);
  assert.equal(reads.page({ scope: "explore", q: "Bounty 999" }, () => true).total, 1);
  assert.throws(() => reads.page({ scope: "explore", status: "toString" }, () => true));
  assert.equal(reads.page({ scope: "mine" }, () => true).total, 0, "no user, no personal scope");
});

test("Home aggregates are shared but personal data stays per user", () => {
  const { reads } = readModelFixture(200);
  const a = reads.home(901, "", 1), b = reads.home(903, "", 1), anon = reads.home(undefined, "", 1);
  assert.deepEqual(a.totals, anon.totals);
  assert.notDeepEqual(a.personal, b.personal);
  assert.equal(anon.personal, null);
  assert.ok(a.rows.length <= 5);
});

test("bounty saves are compare-and-swap protected", () => {
  const { store } = readModelFixture(1);
  const id = "00000000-0000-4000-8000-000000000000";
  const x = store.bounty(id), y = store.bounty(id);
  x.title = "new";
  store.save(x);
  y.status = "Paid";
  assert.throws(() => store.save(y), StaleBountyError);
  store.update(id, (fresh) => (fresh.status = "Claimed"));
  assert.equal(store.bounty(id).title, "new");
});

// ---------- Backup and restore drill ----------

test("settlement waits reset old failure backoff and recover without duplicate authorization or payout", async () => {
  const store = new TaskStore(":memory:");
  const sim = new ChainSim();
  const s = service(store, sim);
  const t = await ready(s);
  merge(s, t.id);
  let pending = true;
  const release = sim.release.bind(sim);
  sim.release = async task => {
    if (pending) throw new PaymentPending("Waiting for gas sponsorship confirmations");
    await release(task);
  };
  for (let i = 0; i < 8; i++) store.retry(t.id, "previous provider failure");
  for (let i = 0; i < 3; i++) {
    store.db.prepare("UPDATE queue SET next_at=0 WHERE task_id=?").run(t.id);
    await s.tick();
    const q = store.db.prepare("SELECT attempts,error,next_at FROM queue WHERE task_id=?").get(t.id)!;
    assert.equal(q.attempts, 0);
    assert.equal(q.error, null);
    assert.ok(Number(q.next_at) <= Date.now() + 2100, "normal polling, not exponential failure backoff");
    assert.equal(store.get(t.id).payment.state, "Authorized");
    assert.equal(sim.broadcasts, 0);
  }
  pending = false;
  store.enqueue(t.id);
  await s.tick();
  sim.chain.set(t.id, "Processed");
  store.enqueue(t.id);
  await s.tick();
  store.enqueue(t.id);
  await s.tick();
  assert.equal(store.get(t.id).payment.state, "Processed");
  assert.equal(store.get(t.id).payment.error, null);
  assert.equal(sim.broadcasts, 1);
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM releases").get() as { n: number }).n, 1);
  assert.equal(store.db.prepare("SELECT 1 FROM queue WHERE task_id=?").get(t.id), undefined);
  store.close();
});

test("backup → restore drill on a temporary database, key pairing enforced", () => {
  const db = tempDb();
  try {
    const key = randomBytes(32);
    const tasks = new TaskStore(db.path);
    const store = new PortalStore(tasks.db, db.dir, key);
    store.saveUser({ id: 7, login: "u", name: "U", avatar: "", token: "secret-token", createdAt: "" });
    tasks.db.prepare("INSERT INTO tasks(id,body) VALUES('t1',?)").run(JSON.stringify({ id: "t1", payment: { state: "Signing" } }));
    writeFileSync(join(db.dir, "github-relayer.json"), JSON.stringify({ jobs: { 3: {} }, reportedOrders: [], submitted: {}, pendingSubmissions: { 4: { memo: "m", at: "" } } }));
    process.env.PORTAL_ENCRYPTION_KEY = key.toString("base64");
    const out = join(db.dir, "backup");
    const manifest = backup({ dataDir: db.dir, dbPath: db.path, out });
    assert.equal(manifest.counts.tasks, 1);
    const restored = restoreCheck({ backup: out, target: join(db.dir, "restore"), key });
    assert.equal(restored.usersDecrypted, 1);
    assert.equal(restored.paymentsInFlight, 1);
    assert.equal(restored.journals[0]!.pendingSubmissions, 1, "uncertain submissions survive restore");
    assert.throws(() => restoreCheck({ backup: out, target: join(db.dir, "restore2"), key: randomBytes(32) }), /does not belong/);
    assert.throws(() => restoreCheck({ backup: out, target: join(db.dir, "restore"), key }), /must be empty/);
    tasks.close();
  } finally {
    delete process.env.PORTAL_ENCRYPTION_KEY;
    db.cleanup();
  }
});

// ---------- Logging and hosted configuration ----------

test("logs redact tokens, keys and IBANs", () => {
  const out = JSON.stringify(redact({ token: "abc", note: "paid FR1420041010050500013M02606 via ghp_000000000000000000000000000000000000 Bearer abcdefghijklmnop", nested: { clientSecret: "x" } }));
  assert.equal(/FR1420041010050500013M02606|ghp_|abcdefghijklmnop|"x"/.test(out), false);
});

test("hosted mode refuses localhost origins, split origins and local credentials", () => {
  const ok = { NEARPORTAL_HOSTED: "1", APP_ORIGIN: "https://nearportal.example", PORTAL_ENCRYPTION_KEY: "k", TASK_ADMIN_TOKEN: "t", SITE_DIR: "../site" } as NodeJS.ProcessEnv;
  assert.equal(hostedConfig(ok).publicOrigin, "https://nearportal.example");
  assert.throws(() => hostedConfig({ ...ok, APP_ORIGIN: "http://127.0.0.1:8787" }), /https/);
  assert.throws(() => hostedConfig({ ...ok, PORTAL_FRONTEND_ORIGIN: "https://other.example" }), /single public origin/);
  assert.throws(() => hostedConfig({ ...ok, GITHUB_USE_CLI: "1" }), /GITHUB_USE_CLI/);
  assert.throws(() => hostedConfig({ ...ok, SITE_DIR: undefined }), /SITE_DIR/);
  assert.equal(hostedConfig({ APP_ORIGIN: "http://127.0.0.1:8787" }).hosted, false, "local mode unchanged");
  const pilot = { ...ok, NEARPORTAL_USDC_PILOT: "1", TASK_PAYMENT_MODE: "sandbox", TASK_BANK_ENABLED: "0", CRYPTO_USDC_ENABLED: "1", PORTAL_ALLOWED_GITHUB_IDS: "1001" };
  assert.equal(hostedConfig(pilot).hosted, true);
  assert.equal(hostedConfig({ ...pilot, PORTAL_ALLOWED_GITHUB_IDS: "*" }).hosted, true);
  assert.throws(() => hostedConfig({ ...pilot, TASK_BANK_ENABLED: "1" }), /USDC pilot requires sandbox/);
  assert.throws(() => hostedConfig({ ...pilot, PORTAL_ALLOWED_GITHUB_IDS: undefined }), /explicit PORTAL_ALLOWED_GITHUB_IDS/);
  assert.throws(() => hostedConfig({ ...pilot, PORTAL_ALLOWED_GITHUB_IDS: "owner" }), /account list is invalid/);
  assert.throws(() => hostedConfig({ ...pilot, PORTAL_ALLOWED_GITHUB_IDS: "*,1001" }), /account list is invalid/);
});

test("generated GitHub issues link to the public origin, never to localhost", async () => {
  const { PortalService } = await import("../server/portal/service.ts");
  const tasks = new TaskStore(":memory:");
  const store = new PortalStore(tasks.db, "", randomBytes(32));
  const portal = new PortalService(store, service(tasks, new ChainSim()));
  const saved = { APP_ORIGIN: process.env.APP_ORIGIN, PORTAL_FRONTEND_ORIGIN: process.env.PORTAL_FRONTEND_ORIGIN };
  try {
    process.env.APP_ORIGIN = "https://nearportal.example";
    delete process.env.PORTAL_FRONTEND_ORIGIN;
    const body = portal.issueBody({ id: "b1", code: "NP-0000000001", description: "d", criteria: ["c"], amountCents: 100, checkName: "acceptance", owner: "o" } as Bounty);
    assert.match(body, /https:\/\/nearportal\.example\/bounties\/b1/);
    assert.equal(/localhost|127\.0\.0\.1/.test(body), false);
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});
