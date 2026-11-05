// End-to-end over HTTP in SIMULATION mode: the real server process (routes, sessions, CSRF,
// quotas, worker, lifecycle, rail adapters) on a temporary database, with the simulated escrow
// chain and a local mock GitHub. No funds, no testnet, no external traffic.
// Drives, for BOTH rails: create (fixed + deadline) → publish → fund → concurrent claims (one
// winner) → assignment confirmation → timely submission → relay; plus withdrawal → reopen.
// Usage: node --import tsx scripts/e2e/simulated-fixed.ts [--out=dir] [--shots]
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { TaskStore } from "../../server/tasks/store.ts";
import { PortalStore, digest } from "../../server/portal/store.ts";

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const OUT = resolve(arg("out", "e2e-simulated"));
const SHOTS = process.argv.includes("--shots");
mkdirSync(OUT, { recursive: true });
const PORT = 19000 + Math.floor(Math.random() * 500), GH = PORT + 600, ORIGIN = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "np-e2e-fixed-"));
const key = randomBytes(32);
const results: { step: string; ok: boolean; detail?: string }[] = [];
const check = (step: string, ok: unknown, detail = "") => {
  results.push({ step, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? " — " + detail : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- mock GitHub ----
const prs = new Map<number, unknown>();
let issueNumber = 40;
const gh = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const pull = /^\/repos\/acme\/widgets\/pulls\/(\d+)$/.exec(url.pathname);
  if (pull) return prs.has(Number(pull[1])) ? send(200, prs.get(Number(pull[1]))) : send(404, {});
  if (url.pathname === "/repos/acme/widgets/issues" && req.method === "POST") { issueNumber++; return send(201, { number: issueNumber, html_url: `https://github.com/acme/widgets/issues/${issueNumber}` }); }
  if (url.pathname.startsWith("/repos/acme/widgets/issues")) return send(200, []);
  if (url.pathname.startsWith("/repos/acme/widgets/pulls")) return send(200, []);
  if (url.pathname === "/repos/acme/widgets") return send(200, { id: 100, full_name: "acme/widgets", private: false, permissions: { push: true }, allow_squash_merge: true, archived: false, default_branch: "main" });
  return send(404, {});
});
await new Promise<void>((r) => gh.listen(GH, "127.0.0.1", r));

// ---- seed users and sessions (no GitHub OAuth needed) ----
const dbPath = join(dir, "github-tasks.sqlite");
{
  const store = new TaskStore(dbPath);
  const portal = new PortalStore(store.db, dir, key);
  for (const [id, login] of [[1001, "acme-owner"], [2002, "dev-ada"], [2003, "dev-bo"]] as const) {
    portal.saveUser({ id, login, name: login, avatar: "", token: `gho_mock_${login}`, createdAt: new Date().toISOString() });
  }
  store.close();
}
const sessions: Record<string, { cookie: string; csrf: string; id: number }> = {};
{
  const store = new TaskStore(dbPath);
  for (const [name, id] of [["owner", 1001], ["ada", 2002], ["bo", 2003]] as const) {
    const token = randomBytes(24).toString("base64url"), csrf = randomBytes(24).toString("base64url");
    store.db.prepare("INSERT INTO portal_sessions VALUES(?,?,?,?)").run(digest(token), id, csrf, Date.now() + 86_400_000);
    sessions[name] = { cookie: `np_session=${token}`, csrf, id };
  }
  store.close();
}

// ---- server under test ----
const server = spawn(process.execPath, ["--import", "tsx", "server/tasks.ts"], {
  cwd: resolve(import.meta.dirname, "../.."),
  env: { PATH: process.env.PATH, HOME: dir, ENV_FILE: join(dir, "none.env"), HOST: "127.0.0.1", PORT: String(PORT), DATA_DIR: dir, TASK_DB: dbPath, APP_ORIGIN: ORIGIN, TASK_PAYMENT_MODE: "simulation", TASK_GITHUB_MODE: "fixture", GITHUB_API_BASE: `http://127.0.0.1:${GH}`, PORTAL_ENCRYPTION_KEY: key.toString("base64"), SITE_DIR: resolve(import.meta.dirname, "../../../site/dist"), LOG_LEVEL: "warn" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
for (let i = 0; !(await fetch(`${ORIGIN}/api/portal/livez`).then((r) => r.ok, () => false)); i++) {
  if (i > 100) throw new Error("server did not start\n" + log.slice(-1500));
  await sleep(200);
}
const api = async (who: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const s = sessions[who]!;
  const r = await fetch(`${ORIGIN}/api/portal${path}`, { method: body === undefined ? "GET" : "POST", headers: { Cookie: s.cookie, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: ORIGIN, "X-CSRF-Token": s.csrf }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: (await r.json()) as any };
};
const until = async <T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000) => {
  const start = Date.now();
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(300);
  }
};

// ---- screenshots (optional) ----
let browser: any = null;
async function shot(name: string, who: string, path: string, width = 1440) {
  if (!SHOTS) return;
  const { chromium } = await import("playwright");
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
  await context.addCookies([{ name: "np_session", value: sessions[who]!.cookie.split("=")[1], url: ORIGIN }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("console", (m: any) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(ORIGIN + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  // A render exception is caught by the page and shown as a connection problem: treat it as an error.
  if (await page.evaluate(() => /Connection interrupted/.test(document.body.innerText))) errors.push("page reports a failed load/render");
  await page.screenshot({ path: join(OUT, `${name}-${width}.png`), fullPage: true });
  check(`screenshot ${name} @${width}: no JS errors, no horizontal overflow`, !errors.length && !overflow, errors.join(" | "));
  await context.close();
}

const draft = (rail: "bank" | "base-usdc") => ({ repository: "acme/widgets", title: rail === "bank" ? "Export filtered rows to CSV" : "Add USDC receipt links", description: "Implement the feature with tests.", criteria: "Escape commas and quotes\nKeep zero and false", amountCents: 2500, branch: "main", checkName: "acceptance", workflowPath: ".github/workflows/acceptance.yml", protectedPaths: "package.json", marketTerms: { kind: "fixed", deliveryHours: 48 }, ...(rail === "base-usdc" ? { paymentRail: "base-usdc" } : {}) });

async function fundedBounty(rail: "bank" | "base-usdc") {
  const created = await api("owner", "/bounties", draft(rail));
  check(`[${rail}] owner saves a fixed-price draft with a 48 h delivery`, created.status === 201 && created.data.bounty.marketTerms?.deliveryHours === 48, JSON.stringify(created.data).slice(0, 160));
  const b = created.data.bounty;
  const published = await api("owner", `/bounties/${b.id}/publish`, { revision: b.revision });
  check(`[${rail}] publish accepted (capability open in simulation)`, published.status === 200, JSON.stringify(published.data).slice(0, 160));
  await until(`[${rail}] escrow prepared`, () => api("owner", `/bounties/${b.id}`), (r) => Boolean(r.data.bounty.task?.clientAccepted && r.data.bounty.market));
  const early = await api("ada", `/bounties/${b.id}/claim`, { policyHash: "x" });
  check(`[${rail}] claim before funding is refused (not visible to developers yet)`, early.status >= 400, early.data.error);
  const fund = await api("owner", `/bounties/${b.id}/simulate-fund`, {});
  check(`[${rail}] simulated funding recorded`, fund.status === 200, fund.data.error ?? "");
  await until(`[${rail}] available and published`, () => api("owner", `/bounties/${b.id}`), (r) => r.data.bounty?.market?.phase === "available" && r.data.bounty.published === true);
  const ready = await api("ada", `/bounties/${b.id}`);
  return ready.data.bounty;
}
async function claimBody(who: string, b: any) {
  if (b.paymentRail !== "base-usdc") {
    const me = await api(who, "/me");
    return { policyHash: b.task.policyHash, payoutVersion: me.data.payout?.version };
  }
  const account = privateKeyToAccount(("0x" + (who === "ada" ? "11" : "22").repeat(32)) as `0x${string}`);
  const challenge = await api(who, `/bounties/${b.id}/wallet-challenge`, { walletAddress: account.address });
  const signature = await account.signMessage({ message: challenge.data.message });
  return { walletAddress: account.address, nonce: challenge.data.nonce, signature, policyHash: b.task.policyHash };
}

try {
  for (const who of ["ada", "bo"]) await api(who, "/payout", { firstName: who, lastName: "Dev", iban: "FR1420041010050500013M02606", country: "FR" });
  for (const rail of ["bank", "base-usdc"] as const) {
    const b = await fundedBounty(rail);
    await shot(`${rail}-available`, "ada", `/bounties/${b.id}`);
    check(`[${rail}] owner does not see Claim on their bounty`, (await api("owner", `/bounties/${b.id}`)).data.bounty.canClaim === false);
    // Two developers claim at the same moment.
    const [ca, cb] = await Promise.all([claimBody("ada", b), claimBody("bo", b)]);
    const race = await Promise.all([api("ada", `/bounties/${b.id}/claim`, ca), api("bo", `/bounties/${b.id}/claim`, cb)]);
    const winners = race.filter((r) => r.status === 202);
    check(`[${rail}] concurrent claims over HTTP: exactly one winner`, winners.length === 1, race.map((r) => r.status).join(","));
    const winner = race[0]!.status === 202 ? "ada" : "bo", loser = winner === "ada" ? "bo" : "ada";
    const processing = winners[0]!.data.bounty.market.assignment;
    check(`[${rail}] claim answers immediately with "assignment processing" (no deadline yet)`, processing && processing.confirmed === false && processing.deadline === null);
    const confirmed = await until(`[${rail}] confirmed`, () => api(winner, `/bounties/${b.id}`), (r) => r.data.bounty.market?.assignment?.confirmed === true);
    const a = confirmed.data.bounty.market.assignment;
    check(`[${rail}] deadline = confirmation + 48 h, marker ${a.marker}`, a.deadline - a.acceptedAt === 48 * 3600_000 && a.marker.endsWith("-A1"));
    const other = await api(loser, `/bounties/${b.id}`);
    check(`[${rail}] the other developer sees no Claim on an assigned bounty`, other.data.bounty.canClaim === false && other.data.bounty.market.assignment.mine === false);
    await shot(`${rail}-in-progress-developer`, winner, `/bounties/${b.id}`);
    await shot(`${rail}-in-progress-developer`, winner, `/bounties/${b.id}`, 390);
    await shot(`${rail}-in-progress-owner`, "owner", `/bounties/${b.id}`);
    // Submission: CSRF, wrong marker, then a valid timely PR.
    const noCsrf = await fetch(`${ORIGIN}/api/portal/bounties/${b.id}/submit`, { method: "POST", headers: { Cookie: sessions[winner]!.cookie, "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ prNumber: 5 }) });
    check(`[${rail}] submit without CSRF token is rejected`, noCsrf.status === 403);
    const pr = rail === "bank" ? 5 : 6;
    prs.set(pr, { number: pr, user: { id: sessions[winner]!.id }, base: { ref: "main", repo: { id: 100 } }, head: { sha: (rail === "bank" ? "a" : "c").repeat(40) }, body: `NearPortal-Task: ${b.code}`, state: "open", merged: false, changed_files: 2, additions: 30, deletions: 1, created_at: new Date().toISOString() });
    const wrong = await api(winner, `/bounties/${b.id}/submit`, { prNumber: pr });
    check(`[${rail}] a PR without the assignment marker does not reserve the bounty`, wrong.status === 400 && /-A1/.test(wrong.data.error), wrong.data.error);
    (prs.get(pr) as { body: string }).body = `Implements the brief.\n\nNearPortal-Task: ${a.marker}`;
    const sub = await api(winner, `/bounties/${b.id}/submit`, { prNumber: pr, expectedRevision: confirmed.data.bounty.market.revision });
    check(`[${rail}] timely submission recorded durably before the 202`, sub.status === 202 && sub.data.bounty.market.assignment.submission?.prNumber === pr, JSON.stringify(sub.data).slice(0, 120));
    const relayed = await until(`[${rail}] relayed`, () => api(winner, `/bounties/${b.id}`), (r) => Boolean(r.data.bounty.task?.marketSubmission?.relayedAt));
    check(`[${rail}] submission recorded on the (simulated) escrow; status "Submitted", not paid`, relayed.data.bounty.task.payment.state === "NotRequested" && relayed.data.bounty.market.phase === "in-review");
    await shot(`${rail}-submitted`, winner, `/bounties/${b.id}`);
    // Second bounty: claim then release.
    const b2 = await fundedBounty(rail);
    const c2 = await api("ada", `/bounties/${b2.id}/claim`, await claimBody("ada", b2));
    check(`[${rail}] second bounty claimed`, c2.status === 202, c2.data.error ?? "");
    const ok2 = await until(`[${rail}] b2 confirmed`, () => api("ada", `/bounties/${b2.id}`), (r) => r.data.bounty.market?.assignment?.confirmed === true);
    const w = await api("ada", `/bounties/${b2.id}/withdraw`, { generation: ok2.data.bounty.market.assignment.generation, expectedRevision: ok2.data.bounty.market.revision });
    check(`[${rail}] release requested`, w.status === 202, w.data.error ?? "");
    const reopened = await until(`[${rail}] reopened`, () => api("bo", `/bounties/${b2.id}`), (r) => r.data.bounty.market?.phase === "available");
    check(`[${rail}] after release the bounty is available with funds still secured`, reopened.data.bounty.task.funded === true && reopened.data.bounty.canClaim === true && reopened.data.bounty.market.history[0].reason === "withdrawn");
  }
  const list = await api("bo", "/bounties?scope=explore&limit=48");
  check("Explore lists all four deadline bounties with server-side counts", list.data.total === 4, JSON.stringify(list.data.counts));
  await shot("create-reward-step", "owner", "/app/new");
  const metrics = await fetch(`${ORIGIN}/api/ops/metrics`).then((r) => r.text());
  check("market commands are observable in metrics", /market_commands_total\{command="claim"\}/.test(metrics));
} catch (error) {
  check("scenario completed", false, String((error as Error).message));
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
  gh.close();
  rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed, failed, results }, null, 2));
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
