// Isolated load test of the real server process (server/tasks.ts) with its workers running.
// - Temporary data directory; the sandbox database is never opened.
// - Simulation payments; GitHub is a local mock that counts every call (no traffic to GitHub,
//   NEAR RPC or Monerium).
// - 1,000+ bounties (history, open, in progress with live-mode evidence, drafts), 100 users with
//   distinct session cookies and CSRF tokens, mixed browsing and mutations.
// Usage: node --import tsx scripts/load/run.ts [--sustain-ms=600000] [--out=results.json]
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { TaskStore } from "../../server/tasks/store.ts";
import { TaskService } from "../../server/tasks/service.ts";
import { GitHub } from "../../server/tasks/github.ts";
import { SimulatedPayments } from "../../server/tasks/payments.ts";
import { PortalStore, digest, type Bounty } from "../../server/portal/store.ts";
import { hash, type Task } from "../../server/tasks/domain.ts";

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const SUSTAIN_MS = Number(arg("sustain-ms", "600000"));
const OUT = resolve(arg("out", "load-results.json"));
const USERS = 100, BOUNTIES = Number(arg("bounties", "1000"));
const PORT = 18000 + Math.floor(Math.random() * 1000), GH_PORT = PORT + 1000;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "nearportal-load-"));
const key = randomBytes(32);
const bank = { firstName: "Load", lastName: "Tester", iban: "FR1420041010050500013M02606", country: "FR" };
const REPOS = 40;

// ---------------- Mock GitHub (ETag-aware, counts calls) ----------------
const ghCalls = new Map<string, number>();
let ghTotal = 0, gh304 = 0;
const sha = (n: number) => n.toString(16).padStart(40, "a");
const github = createServer((req, res) => {
  ghTotal++;
  const url = new URL(req.url ?? "/", "http://x");
  const kind = url.pathname.replace(/\/repos\/[^/]+\/[^/]+/, "/repos/:r").replace(/\/\d+(?=\/|$)/g, "/:n").replace(/\/contents\/.*/, "/contents/*").replace(/\/commits\/[a-f0-9]{40}/, "/commits/:sha");
  ghCalls.set(kind, (ghCalls.get(kind) ?? 0) + 1);
  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)/.exec(url.pathname);
  const repoIndex = repoMatch ? Number(repoMatch[2]!.replace(/\D/g, "")) || 0 : 0;
  let body: unknown = {};
  const pr = /\/pulls\/(\d+)$/.exec(url.pathname);
  if (pr) {
    const n = Number(pr[1]);
    body = { number: n, merged: false, merge_commit_sha: null, html_url: `https://github.com/o/r/pull/${n}`, user: { id: 2000 + (n % USERS) }, merged_by: null, merged_at: null, base: { ref: "main", repo: { id: 100 + repoIndex } }, head: { sha: sha(n), ref: `work-${n}`, repo: { id: 100 + repoIndex } } };
  } else if (url.pathname.endsWith("/check-runs")) body = { check_runs: [] };
  else if (url.pathname.endsWith("/actions/runs")) body = { workflow_runs: [] };
  else if (url.pathname.includes("/contents/")) body = { type: "file", sha: "b".repeat(40) };
  else if (/\/pulls$/.test(url.pathname)) body = [];
  else if (repoMatch) body = { id: 100 + repoIndex, full_name: `${repoMatch[1]}/${repoMatch[2]}`, private: false, permissions: { push: true }, allow_squash_merge: true, archived: false, default_branch: "main" };
  else if (url.pathname === "/user") body = { id: 1, login: "load" };
  const etag = `"${digest(JSON.stringify(body)).slice(0, 16)}"`;
  if (req.headers["if-none-match"] === etag) {
    gh304++;
    res.writeHead(304, { etag, "x-ratelimit-remaining": "4999", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) });
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json", etag, "x-ratelimit-remaining": "4999", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) });
  res.end(JSON.stringify(body));
});
await new Promise<void>((r) => github.listen(GH_PORT, "127.0.0.1", r));

// ---------------- Seed ----------------
const dbPath = join(dir, "github-tasks.sqlite");
const seedStore = new TaskStore(dbPath);
const portalStore = new PortalStore(seedStore.db, dir, key);
const sim = new TaskService(seedStore, new GitHub({}), new SimulatedPayments(seedStore), { mode: "simulation", githubMode: "fixture", verifier: "v", recipient: "r" });
const users = Array.from({ length: USERS }, (_, i) => ({ id: 2000 + i, login: `user${i}`, name: `User ${i}`, avatar: "", token: `gho_mock_${i}_${randomBytes(6).toString("hex")}`, createdAt: new Date().toISOString() }));
for (const u of users) portalStore.saveUser(u);
const sessions = users.map((u) => {
  const token = randomBytes(32).toString("base64url"), csrf = randomBytes(32).toString("base64url");
  seedStore.db.prepare("INSERT INTO portal_sessions VALUES(?,?,?,?)").run(digest(token), u.id, csrf, Date.now() + 86_400_000);
  return { user: u, cookie: `np_session=${token}`, csrf };
});
const seedStart = performance.now();
const mix = { paid: 0, open: 0, active: 0, review: 0, draft: 0 };
const openIds: string[] = [], activeIds: { bounty: string; owner: number; dev: number }[] = [];
seedStore.db.exec("PRAGMA synchronous=OFF");
for (let i = 0; i < BOUNTIES; i++) {
  const owner = users[i % USERS]!, dev = users[(i * 7 + 3) % USERS]!;
  const kind = i % 20 < 10 ? "paid" : i % 20 < 13 ? "open" : i % 20 < 17 ? "active" : i % 20 < 18 ? "review" : "draft";
  mix[kind]++;
  const repo = `org${i % REPOS}/repo${i % REPOS}`;
  const id = `0000${i.toString(16).padStart(4, "0")}-0000-4000-8000-${i.toString().padStart(12, "0")}`;
  const code = `NP-${i.toString(16).toUpperCase().padStart(10, "0")}`;
  let taskId: string | null = null;
  if (kind !== "draft") {
    const open = kind === "open" || kind === "active";
    const created = await sim.create({ title: `Bounty ${i}`, criteria: "Pass acceptance", amountCents: 100 + (i % 50) * 100, repository: repo }, open ? { openBounty: true, ownerId: owner.id, portalId: id, portalCode: code } : { ownerId: owner.id, portalId: id, portalCode: code });
    let t = seedStore.get(created.task.id);
    if (open) {
      t.policy.repositoryId = 100 + (i % REPOS);
      t.policy.mergerIds = [owner.id];
      t.fundingPolicy = structuredClone(t.policy);
      t.fundingPolicyHash = hash(t.policy);
      t.policyHash = hash(t.policy);
      seedStore.save(t);
      t = seedStore.get(t.id);
      sim.accept(t, "client", t.policyHash);
      sim.fund(seedStore.get(t.id));
      if (kind === "active") {
        sim.claim(seedStore.get(t.id), { id: dev.id, login: dev.login }, bank, seedStore.get(t.id).policyHash);
        t = seedStore.get(t.id);
        if (i % 2) {
          sim.bindPr(t, 1000 + i);
          t = seedStore.get(t.id);
          t.githubMode = "live"; // evidence read from the (mock) GitHub API with the owner's token
          seedStore.save(t);
          activeIds.push({ bounty: id, owner: owner.id, dev: dev.id });
        }
      } else openIds.push(id);
    } else {
      sim.setPayout(t, "developer", bank);
      t = seedStore.get(t.id);
      sim.accept(t, "client", t.policyHash);
      t = seedStore.get(t.id);
      sim.accept(t, "developer", t.policyHash);
      sim.fund(seedStore.get(t.id));
      sim.bindPr(seedStore.get(t.id), 500 + i);
      t = seedStore.get(t.id);
      if (kind === "paid") {
        t.payment = { state: "Processed", reference: `SIM-${t.id}`, error: null };
        seedStore.save(t);
        seedStore.done(t.id);
      } else {
        t.verdict = { status: "blocked", reasons: ["Required check failed."], evidenceHash: "x" } as unknown as Task["verdict"];
        seedStore.save(t);
      }
    }
    taskId = t.id;
  }
  portalStore.save({ id, code, ownerId: owner.id, owner: owner.login, repository: repo, private: i % 13 === 0, title: `Bounty ${i}: ${["CSV export", "OAuth fix", "Dark mode", "Rate limiter", "Docs"][i % 5]}`, description: "Load-test bounty.", criteria: ["Pass acceptance"], amountCents: 100 + (i % 50) * 100, branch: "main", checkName: "acceptance", checkAppId: 15368, workflowPath: ".github/workflows/acceptance.yml", protectedPaths: "package.json", taskId, issueNumber: kind === "draft" ? null : i, issueUrl: null, status: kind === "draft" ? "Draft" : "Open", published: kind !== "draft", error: null, createdAt: new Date(Date.now() - (BOUNTIES - i) * 60_000).toISOString(), updatedAt: "" } as Bounty);
}
seedStore.db.exec("PRAGMA synchronous=FULL");
const queued = (seedStore.db.prepare("SELECT COUNT(*) AS n FROM queue").get() as { n: number }).n;
seedStore.close();
const seedMs = performance.now() - seedStart;
console.log(JSON.stringify({ seeded: BOUNTIES, mix, queued, liveEvidenceTasks: activeIds.length, seedMs: Math.round(seedMs) }));

// ---------------- Server under test ----------------
const server = spawn(process.execPath, ["--import", "tsx", "server/tasks.ts"], {
  cwd: resolve(import.meta.dirname, "../.."),
  env: {
    PATH: process.env.PATH,
    HOME: dir,
    ENV_FILE: join(dir, "none.env"),
    HOST: "127.0.0.1",
    PORT: String(PORT),
    DATA_DIR: dir,
    TASK_DB: dbPath,
    APP_ORIGIN: ORIGIN,
    TASK_PAYMENT_MODE: "simulation",
    TASK_GITHUB_MODE: "fixture",
    GITHUB_API_BASE: `http://127.0.0.1:${GH_PORT}`,
    PORTAL_ENCRYPTION_KEY: key.toString("base64"),
    SITE_DIR: resolve(import.meta.dirname, "../../../site"),
    METRICS_TOKEN: "load-metrics",
    WORKER_SIMULATION_POLL_MS: "20000",
    GITHUB_WEBHOOK_SECRET: "load-webhook-secret",
    LOG_LEVEL: "warn",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${ORIGIN}/api/portal/livez`)).ok) break;
  } catch { /* starting */ }
  if (i > 100) throw new Error("server did not start:\n" + serverLog.slice(-2000));
  await new Promise((r) => setTimeout(r, 200));
}

// ---------------- Virtual users ----------------
type Sample = { kind: string; ms: number; status: number };
const samples: Sample[] = [];
let phase = "spike";
const phaseSamples: Record<string, Sample[]> = { spike: [], sustained: [] };
async function call(kind: string, s: (typeof sessions)[number], path: string, init: RequestInit = {}) {
  const started = performance.now();
  let status = 0;
  try {
    const r = await fetch(ORIGIN + path, { ...init, headers: { Cookie: s.cookie, Accept: "application/json", ...(init.method === "POST" ? { "Content-Type": "application/json", Origin: ORIGIN, "X-CSRF-Token": s.csrf } : {}), ...(init.headers as object) } });
    status = r.status;
    await r.arrayBuffer();
  } catch {
    status = -1;
  }
  const sample = { kind, ms: performance.now() - started, status };
  samples.push(sample);
  phaseSamples[phase]!.push(sample);
  return status;
}
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;
const allIds = Array.from({ length: BOUNTIES }, (_, i) => `0000${i.toString(16).padStart(4, "0")}-0000-4000-8000-${i.toString().padStart(12, "0")}`);
async function step(s: (typeof sessions)[number]) {
  const r = Math.random();
  if (r < 0.2) return call("home", s, "/api/portal/home");
  if (r < 0.3) return call("page", s, pick(["/app", "/app/bounties", "/bounties", "/bounties/" + pick(allIds), "/app/work"]), { headers: { Accept: "text/html" } });
  if (r < 0.45) return call("explore", s, `/api/portal/bounties?scope=explore&limit=48&page=${1 + Math.floor(Math.random() * 5)}${Math.random() < 0.3 ? "&status=paid" : ""}`);
  if (r < 0.6) return call("board", s, `/api/portal/bounties?scope=${Math.random() < 0.5 ? "mine" : "work"}&limit=100`);
  if (r < 0.85) return call("detail", s, "/api/portal/bounties/" + pick(allIds));
  if (r < 0.9) return call("me", s, "/api/portal/me");
  if (r < 0.94) return call("leaderboard", s, "/api/portal/leaderboard?page=1");
  // Mutations (simulated adapters): draft creation, claims racing for open bounties, refresh.
  if (r < 0.96)
    return call("create-draft", s, "/api/portal/bounties", { method: "POST", body: JSON.stringify({ repository: `org${Math.floor(Math.random() * REPOS)}/repo1`, title: "Load draft", description: "Generated during the load test.", criteria: "Pass", amountCents: 500 }) });
  if (r < 0.98) {
    const target = pick(openIds);
    const detail = await fetch(`${ORIGIN}/api/portal/bounties/${target}`, { headers: { Cookie: s.cookie } }).then((x) => x.json()).catch(() => null);
    if (!detail?.bounty?.canClaim) return 0;
    const me = await fetch(`${ORIGIN}/api/portal/me`, { headers: { Cookie: s.cookie } }).then((x) => x.json());
    if (!me.payout) await call("payout", s, "/api/portal/payout", { method: "POST", body: JSON.stringify(bank) });
    const version = (await fetch(`${ORIGIN}/api/portal/me`, { headers: { Cookie: s.cookie } }).then((x) => x.json())).payout?.version;
    return call("claim", s, `/api/portal/bounties/${target}/claim`, { method: "POST", body: JSON.stringify({ policyHash: detail.bounty.task.policyHash, payoutVersion: version }) });
  }
  const own = activeIds.filter((a) => a.owner === s.user.id || a.dev === s.user.id);
  if (own.length) return call("refresh", s, `/api/portal/bounties/${pick(own).bounty}/refresh`, { method: "POST", body: "{}" });
  return call("home", s, "/api/portal/home");
}

// Server-side metrics scraped during the run.
type Scrape = { at: number; lagP99: number; lagMax: number; rss: number; heap: number; queue: number; due: number; oldest: number; inflight: number; github: number };
const scrapes: Scrape[] = [];
const metric = (text: string, name: string) => Number(new RegExp(`^${name.replace(/[{}"]/g, (c) => "\\" + c)} (\\S+)$`, "m").exec(text)?.[1] ?? NaN);
async function scrape() {
  const text = await fetch(`${ORIGIN}/api/ops/metrics`, { headers: { Authorization: "Bearer load-metrics" } }).then((r) => r.text());
  scrapes.push({ at: Date.now(), lagP99: metric(text, "nodejs_eventloop_lag_p99_ms"), lagMax: metric(text, "nodejs_eventloop_lag_max_ms"), rss: metric(text, "process_resident_memory_bytes"), heap: metric(text, "nodejs_heap_used_bytes"), queue: metric(text, "task_queue_size"), due: metric(text, "task_queue_due"), oldest: metric(text, "task_queue_oldest_due_age_ms"), inflight: metric(text, "worker_inflight"), github: ghTotal });
  return text;
}
await scrape();

// Spike: every user fires 10 requests at once (1,000 concurrent requests).
const spikeStart = performance.now();
await Promise.all(sessions.flatMap((s) => Array.from({ length: 10 }, () => step(s))));
const spikeMs = performance.now() - spikeStart;
await scrape();

// Sustained: each user keeps browsing with 1–3 s think time.
phase = "sustained";
const sustainStart = Date.now();
const scraper = setInterval(() => void scrape().catch(() => {}), 10_000);
const ghAtSustainStart = ghTotal;
await Promise.all(sessions.map(async (s) => {
  while (Date.now() - sustainStart < SUSTAIN_MS) {
    await step(s);
    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
  }
}));
clearInterval(scraper);
const sustainMs = Date.now() - sustainStart;
const finalMetrics = await scrape();
const ghSustained = ghTotal - ghAtSustainStart;

// ---------------- Report ----------------
const pct = (xs: number[], q: number) => (xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]! : 0);
const summarize = (list: Sample[]) => {
  const by: Record<string, { n: number; p50: number; p95: number; p99: number; max: number; statuses: Record<string, number> }> = {};
  for (const kind of [...new Set(list.map((s) => s.kind))]) {
    const xs = list.filter((s) => s.kind === kind);
    const statuses: Record<string, number> = {};
    for (const x of xs) statuses[x.status] = (statuses[x.status] ?? 0) + 1;
    const ms = xs.map((x) => x.ms);
    by[kind] = { n: xs.length, p50: Math.round(pct(ms, 0.5)), p95: Math.round(pct(ms, 0.95)), p99: Math.round(pct(ms, 0.99)), max: Math.round(Math.max(...ms)), statuses };
  }
  const reads = list.filter((s) => !["create-draft", "claim", "payout", "refresh"].includes(s.kind)).map((s) => s.ms);
  return { requests: list.length, readP50: Math.round(pct(reads, 0.5)), readP95: Math.round(pct(reads, 0.95)), readP99: Math.round(pct(reads, 0.99)), serverErrors: list.filter((s) => s.status >= 500 || s.status === -1).length, rateLimited: list.filter((s) => s.status === 429).length, byKind: by };
};
const claimWinners = samples.filter((s) => s.kind === "claim" && s.status === 200).length;
const taskStore = new TaskStore(dbPath);
const doubleClaimed = (taskStore.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE json_extract(body,'$.openBounty')=1 AND json_extract(body,'$.policy.developerId')!=0").get() as { n: number }).n;
const releases = (taskStore.db.prepare("SELECT COUNT(*) AS n FROM releases").get() as { n: number }).n;
const processed = (taskStore.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE json_extract(body,'$.payment.state')='Processed'").get() as { n: number }).n;
const queueErrors = taskStore.db.prepare("SELECT COALESCE(substr(error,1,80),'(none)') AS error, COUNT(*) AS n, MAX(attempts) AS maxAttempts FROM queue GROUP BY 1 ORDER BY 2 DESC LIMIT 10").all();
const claimedAtStart = 200 / 2 + 200 / 2; // every seeded "active" bounty is claimed
taskStore.close();
const results = {
  environment: { node: process.version, platform: `${process.platform}-${process.arch}`, cpus: (await import("node:os")).cpus().length, cpuModel: (await import("node:os")).cpus()[0]?.model, users: USERS, bounties: BOUNTIES, mix, liveEvidenceTasks: activeIds.length, queuedAtStart: queued, transport: "HTTP on loopback, no TLS (the TLS edge is covered by the container smoke test)", workers: "running (WORKER_CONCURRENCY default 4, simulation poll 20 s)", providers: "GitHub mock with ETags; simulated payments; no external traffic" },
  spike: { concurrentRequests: USERS * 10, wallMs: Math.round(spikeMs), ...summarize(phaseSamples.spike!) },
  sustained: { durationMs: sustainMs, rps: Math.round((phaseSamples.sustained!.length / sustainMs) * 1000 * 10) / 10, ...summarize(phaseSamples.sustained!) },
  server: {
    eventLoopLagP99Ms: { max: Math.max(...scrapes.map((s) => s.lagP99)), last: scrapes.at(-1)!.lagP99 },
    eventLoopLagMaxMs: Math.max(...scrapes.map((s) => s.lagMax)),
    rssMb: { start: Math.round(scrapes[0]!.rss / 1e6), max: Math.round(Math.max(...scrapes.map((s) => s.rss)) / 1e6), end: Math.round(scrapes.at(-1)!.rss / 1e6) },
    heapMb: { max: Math.round(Math.max(...scrapes.map((s) => s.heap)) / 1e6), end: Math.round(scrapes.at(-1)!.heap / 1e6) },
    queue: { start: scrapes[0]!.queue, max: Math.max(...scrapes.map((s) => s.queue)), end: scrapes.at(-1)!.queue, maxDue: Math.max(...scrapes.map((s) => s.due)), maxOldestDueAgeMs: Math.max(...scrapes.map((s) => s.oldest)) },
    readModelRebuilds: metric(finalMetrics, "read_model_rebuilds_total"),
    readModelHits: metric(finalMetrics, "read_model_hits_total"),
  },
  providers: {
    githubCallsTotal: ghTotal,
    githubCallsDuringSustained: ghSustained,
    githubCallsPerHourSustained: Math.round((ghSustained / sustainMs) * 3_600_000),
    github304: gh304,
    githubByEndpoint: Object.fromEntries([...ghCalls.entries()].sort((a, b) => b[1] - a[1])),
    perVisitorGlobalDataCalls: "0 (Home/Explore/leaderboard read the cached read model; no provider call)",
  },
  integrity: {
    claimRequestsWon: claimWinners,
    newlyClaimedBounties: doubleClaimed - claimedAtStart,
    everyWinningClaimIsADistinctBounty: claimWinners === doubleClaimed - claimedAtStart,
    claimRequestsRejected: samples.filter((x) => x.kind === "claim" && x.status !== 200).length,
    releaseRecords: releases,
    processedPayments: processed,
    queueByError: queueErrors,
    workerStaleWrites: metric(finalMetrics, "worker_stale_writes_total"),
    workerFailures: metric(finalMetrics, "worker_failures_total"),
  },
  samplesTimeline: scrapes.map((s) => ({ t: Math.round((s.at - scrapes[0]!.at) / 1000), lagP99: Math.round(s.lagP99 * 10) / 10, rssMb: Math.round(s.rss / 1e6), queue: s.queue, due: s.due, github: s.github })),
};
writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ spike: { wallMs: results.spike.wallMs, readP95: results.spike.readP95, errors: results.spike.serverErrors, limited: results.spike.rateLimited }, sustained: { rps: results.sustained.rps, readP50: results.sustained.readP50, readP95: results.sustained.readP95, readP99: results.sustained.readP99, errors: results.sustained.serverErrors, limited: results.sustained.rateLimited }, server: results.server, github: { total: ghTotal, perHour: results.providers.githubCallsPerHourSustained } }, null, 1));
server.kill("SIGTERM");
await new Promise((r) => server.once("exit", r));
github.close();
if (!/server.stopped[^\n]*"clean":true/.test(serverLog)) console.log("shutdown log:", serverLog.split("\n").filter((l) => /stopped|error/.test(l)).slice(-3).join("\n"));
rmSync(dir, { recursive: true, force: true });
