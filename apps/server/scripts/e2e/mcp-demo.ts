// Reproducible MCP V1 demonstration (A–L), in ISOLATED SIMULATION:
// - real NearPortal services (TaskService, PortalService, FixedBounties, ReadModel, agent API,
//   Auth with sessions + CSRF) served over HTTP on 127.0.0.1, temporary SQLite, simulated escrow
//   chain, mock GitHub, no funds;
// - the REAL CLI (`nearportal-mcp login`, `wallet verify`, `status`) as child processes;
// - the REAL browser pages (/agent/connect, /agent/wallet) driven by Playwright, with an injected
//   EIP-1193 test wallet (viem key generated for the demo, never a real key);
// - the REAL MCP server over stdio, driven by the official SDK client.
// Usage: node --import tsx scripts/e2e/mcp-demo.ts [--out=dir]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { agentWorld, users, walletOf } from "../../test/agent-world.ts";

const OUT = resolve(process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "mcp-demo");
mkdirSync(OUT, { recursive: true });
const BIN = resolve(import.meta.dirname, "../../mcp/nearportal-mcp.mjs");
const results: { step: string; ok: boolean; detail: string }[] = [];
const transcript: string[] = ["# NearPortal MCP V1 demo transcript (simulation)", ""];
const check = (step: string, ok: unknown, detail = "") => {
  if (!ok) for (const c of children) c.kill("SIGTERM"); // never leave a CLI waiting on a failed browser step
  results.push({ step, ok: Boolean(ok), detail });
  console.error(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? " — " + detail : ""}`);
};
const SECRET = /np[ad]_[A-Za-z0-9_-]{20,}|gho_\w+/g;
const note = (title: string, text: string) => transcript.push(`## ${title}`, "", "```", text.replace(SECRET, "[redacted]").slice(0, 4000), "```", "");

const w = await agentWorld({ staticDir: resolve(import.meta.dirname, "../../public") });
// The demo runs in real time: the controlled clock follows the wall clock.
w.clock.now = Date.now();
const tick = setInterval(() => (w.clock.now = Date.now()), 200);

const { chromium } = await import("playwright");
const browser = await chromium.launch();
async function pageFor(who: string, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const cookie = w.sessions[who]!.cookie.split("=")[1];
  if (!cookie) throw new Error("Missing simulated browser session");
  await context.addCookies([{ name: "np_session", value: cookie, url: w.origin }]);
  return { context, page: await context.newPage() };
}
const homes: Record<string, Record<string, string>> = {};
const envFor = (who: string) => {
  if (!homes[who]) {
    const home = mkdtempSync(join(tmpdir(), `np-demo-${who}-`));
    homes[who] = { PATH: process.env.PATH!, HOME: home, NEARPORTAL_MCP_HOME: join(home, "cfg"), NEARPORTAL_CREDENTIAL_STORE: "file", NEARPORTAL_NO_BROWSER: "1" };
  }
  return homes[who]!;
};
const children = new Set<import("node:child_process").ChildProcess>();
function cli(who: string, args: string[], onStderr?: (text: string) => void) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [BIN, ...args, "--server", w.origin, "--allow-http-loopback"], { env: envFor(who), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => { stderr += d; onStderr?.(stderr); });
    children.add(child);
    child.on("exit", (code) => { children.delete(child); done({ code, stdout, stderr }); });
  });
}
async function mcp(who: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "serve"], env: { ...envFor(who), NEARPORTAL_URL: w.origin, NEARPORTAL_ALLOW_HTTP_LOOPBACK: "1" }, stderr: "pipe" });
  const client = new Client({ name: `demo-${who}`, version: "1.0.0" });
  await client.connect(transport);
  return client;
}
const tool = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as any;
  note(`${name} ${JSON.stringify(args).slice(0, 300)}`, `${r.isError ? "ERROR " : ""}${r.structuredContent?.summary}\nrequestId: ${r.structuredContent?.requestId}`);
  return r;
};

try {
  // ---------- A. CLI login (device flow, human approval in the browser page) ----------
  async function login(who: string, scopes: string, shot: boolean) {
    let approving: Promise<void> | null = null;
    const r = await cli(who, ["login", "--scopes", scopes, "--github-login", users[who]!.login], (text) => {
      const code = /Check this code matches: ([A-Z]{4}-[A-Z]{4})/.exec(text)?.[1];
      if (!code || approving) return;
      approving = (async () => {
        const { context, page } = await pageFor(who);
        await page.goto(`${w.origin}/agent/connect?code=${code}`);
        await page.waitForSelector("#approve:not([hidden])", { state: "visible" });
        if (shot) await page.screenshot({ path: join(OUT, "A-connect-approval-1280.png"), fullPage: true });
        if (scopes.includes("release")) await page.check('input[value="release"]');
        await page.click("#approve");
        await page.waitForFunction(() => /Approved/.test(document.getElementById("result")!.textContent ?? ""));
        if (shot) await page.screenshot({ path: join(OUT, "A-connect-approved-1280.png"), fullPage: true });
        await context.close();
      })().catch((e) => check(`A. ${who}: approval page`, false, String(e).slice(0, 300)));
    });
    await approving;
    note(`CLI login (${who})`, r.stderr);
    check(`A. ${who}: CLI login through the browser approval page`, r.code === 0 && /Connected as @/.test(r.stderr), r.stderr.split("\n").find((l) => l.startsWith("Connected")) ?? r.stderr.slice(-200));
    check(`A. ${who}: stdout of the CLI stays empty; no credential printed`, r.stdout === "" && !SECRET.test(r.stderr));
  }
  await login("ada", "read,contribute,release", true);
  await login("owner", "read,create", false);
  {
    const { context, page } = await pageFor("ada", 390);
    const start = await w.call("POST", "/api/agent/device/code", { body: { clientName: "mobile check", scopes: ["read"] } });
    await page.goto(`${w.origin}/agent/connect?code=${start.data.userCode}`);
    await page.waitForSelector("#approve", { state: "visible" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    await page.screenshot({ path: join(OUT, "A-connect-approval-390.png"), fullPage: true });
    check("A. approval page at 390 px: no horizontal overflow", !overflow);
    await context.close();
  }
  const status = await cli("ada", ["status"]);
  note("CLI status (ada)", status.stderr);
  check("A. status shows account and permissions", /@dev-ada .*read, contribute, release/.test(status.stderr));

  // ---------- B. wallet verification (human signs in the page) and reuse ----------
  const account = walletOf(1);
  const signer = { context: null as any };
  let signed: Promise<void> | null = null;
  const wv = await cli("ada", ["wallet", "verify", account.address], (text) => {
    const url = /Open (http\S+\/agent\/wallet\?request=[a-f0-9-]+)/.exec(text)?.[1];
    if (!url || signed) return;
    signed = (async () => {
      const { context, page } = await pageFor("ada");
      signer.context = context;
      await page.exposeFunction("npDemoSign", (hex: string) => account.signMessage({ message: { raw: hex as `0x${string}` } }));
      // Plain-string init script (a transpiled function would carry loader helpers into the page).
      await page.addInitScript({ content: `window.ethereum = { request: async ({ method, params }) => method === "eth_requestAccounts" ? [${JSON.stringify(account.address)}] : method === "personal_sign" ? window.npDemoSign(params[0]) : Promise.reject(new Error("unsupported")) };` });
      await page.goto(url);
      await page.waitForSelector("#sign", { state: "visible" });
      await page.screenshot({ path: join(OUT, "B-wallet-signature-1280.png"), fullPage: true });
      await page.click("#sign");
      await page.waitForFunction(() => /Wallet verified/.test(document.getElementById("result")!.textContent ?? ""));
      await page.screenshot({ path: join(OUT, "B-wallet-verified-1280.png"), fullPage: true });
      await context.close();
    })().catch((e) => check("B. wallet page", false, String(e).slice(0, 300)));
  });
  await signed;
  note("CLI wallet verify (ada)", wv.stderr);
  check("B. wallet verified by a human signature in the browser page", wv.code === 0 && /Verified 0x/.test(wv.stderr));
  const ada = await mcp("ada");
  const reuse = await tool(ada, "verify_wallet", { address: account.address });
  check("B. verified wallet is reused without a new signature", reuse.structuredContent.data.verified === true);

  // ---------- creator publishes one bounty for the contributor journey ----------
  const owner = await mcp("owner");
  const one = await tool(owner, "prepare_bounties", { items: [w.item(100, { title: "Add CSV export to the widgets table", rewardUsdc: "60", delivery: { hours: 24 } }), w.item(101, { title: "Race: fix pagination off-by-one", rewardUsdc: "20", delivery: { days: 3 } })] });
  const oneBatch = await tool(owner, "create_bounties", { preparationId: one.structuredContent.data.preparationId });
  await w.pass(2);
  const single = w.portalStore.bounty(oneBatch.structuredContent.data.items[0].bountyId);
  const race = w.portalStore.bounty(oneBatch.structuredContent.data.items[1].bountyId);
  for (const b of [single, race]) w.service.fund(w.tasks.get(b.taskId!)); // SIMULATED deposit confirmation (no funds)
  await w.pass(3);

  // ---------- C. search ----------
  const list = await tool(ada, "list_bounties", { query: "csv", minRewardUsdc: "50", maxDeliveryHours: 24, status: "available" });
  check("C. search returns the funded bounty with facts only", list.structuredContent.data.bounties.length === 1 && /untrusted/.test(list.structuredContent.summary));

  // ---------- D. exclusive claim (with a competing claimant) ----------
  const boToken = await w.login("bo", ["read", "contribute"]);
  const boWallet = await w.verifyWallet("bo", boToken, 2);
  const raceHash = (await tool(ada, "get_bounty", { bounty: race.code })).structuredContent.data.agreement.hash;
  const [mine, theirs] = await Promise.all([
    tool(ada, "claim_bounty", { bounty: race.code, walletAddress: account.address, acceptedAgreementHash: raceHash, waitForConfirmationSeconds: 0 }),
    w.call("POST", `/api/agent/v1/bounties/${race.id}/claim`, { bearer: boToken, body: { walletAddress: boWallet, acceptedAgreementHash: raceHash } }),
  ]);
  const adaWon = !mine.isError;
  check("D. two concurrent claims (MCP vs API): exactly one winner, the other gets bounty_already_assigned", adaWon !== (theirs.status === 200) && (adaWon ? theirs.error?.code === "bounty_already_assigned" : mine.structuredContent.error.code === "bounty_already_assigned"), `winner: ${adaWon ? "dev-ada (MCP)" : "dev-bo (API)"}`);
  const terms = await tool(ada, "get_bounty", { bounty: single.code });
  const hash = terms.structuredContent.data.agreement.hash;
  const claimed = await tool(ada, "claim_bounty", { bounty: single.code, walletAddress: account.address, acceptedAgreementHash: hash, waitForConfirmationSeconds: 0 });
  check("D. exclusive claim through MCP with the verified wallet and accepted agreement", !claimed.isError && claimed.structuredContent.data.walletMatches === true);
  const replay = await tool(ada, "claim_bounty", { bounty: single.code, walletAddress: account.address, acceptedAgreementHash: hash, waitForConfirmationSeconds: 0 });
  check("D. retry after a lost response returns the same assignment", replay.structuredContent.data.replayed === true && replay.structuredContent.data.assignment.generation === 1);

  // ---------- E. assignment and deadline ----------
  await w.pass(2);
  const a = await tool(ada, "get_assignment", { bounty: single.code });
  const asg = a.structuredContent.data;
  check("E. assignment confirmed with marker, branch, UTC deadline", asg.state === "in-progress" && /-A1$/.test(asg.marker) && /Z$/.test(asg.deadline) && asg.remainingSecondsIndicative > 23 * 3600, `${asg.marker} due ${asg.deadline}`);

  // ---------- F. submit a PR (opened with the contributor's own git/gh tools; mocked here) ----------
  w.pr(31, users.ada!, asg.marker);
  const sub = await tool(ada, "submit_work", { bounty: single.code, generation: asg.generation, prUrl: "https://github.com/acme/widgets/pull/31" });
  check("F. submission recorded with exact commit and server reception time", sub.structuredContent.data.recorded === true && /^[a-f0-9]{40}$/.test(sub.structuredContent.data.headSha));
  await w.pass(2);

  // ---------- G. creator merges (SIMULATED merge) ----------
  w.service.simulate(w.tasks.get(single.taskId!), "ready", "developer"); // selected job passes (simulated CI)
  await w.pass(2);
  const beforeMerge = await tool(ada, "get_assignment", { bounty: single.code });
  check("G. checks passing is not payment: still in review before the creator's merge", beforeMerge.structuredContent.data.status.key === "inReview" && w.tasks.get(single.taskId!).payment.state === "NotRequested");
  w.service.simulate(w.tasks.get(single.taskId!), "merged", "client");
  // ---------- H. payment once, receipt after confirmation ----------
  await w.pass(4);
  const pay = await tool(ada, "list_my_activity", { kind: "payments" });
  const p = pay.structuredContent.data.payments[0];
  check("G/H. merged by the creator, then paid once with a receipt (simulated payout)", p?.status.key === "paid" && Boolean(p.receipt?.reference));
  await w.pass(3);
  check("H. exactly one release recorded after extra worker passes", (w.tasks.db.prepare("SELECT COUNT(*) AS n FROM releases").get() as { n: number }).n === 1);

  // ---------- I. prepare 10 ----------
  const items = Array.from({ length: 10 }, (_, i) => w.item(i, { title: `Batch task ${i + 1}: harden module ${i + 1}`, rewardUsdc: ["5", "7.50", "10", "12.25", "15", "20", "25", "30", "40", "55.75"][i], delivery: i < 5 ? { days: 2 } : { hours: 36 } }));
  const prep = await tool(owner, "prepare_bounties", { items });
  check("I. 10 bounties validated without any mutation; exact total", prep.structuredContent.data.valid && prep.structuredContent.data.total.amount === "220.50" && /Nothing was created/.test(prep.structuredContent.summary));

  // ---------- J. interrupted creation, then resume ----------
  const create = w.portal.create.bind(w.portal);
  let failed = false;
  w.portal.create = (async (...args: Parameters<typeof create>) => {
    if (!failed && args[1].title === items[4]!.title) { failed = true; throw new Error("GitHub request failed (503)"); }
    return create(...args);
  }) as typeof create;
  const firstRun = await tool(owner, "create_bounties", { preparationId: prep.structuredContent.data.preparationId, batchKey: "demo-batch-2026-11" });
  const batchId = firstRun.structuredContent.data.batchId;
  check("J. interrupted batch reports exactly what to resume", firstRun.structuredContent.data.counts.published === 9 && firstRun.structuredContent.data.toResume.join() === "4");
  const resumed = await tool(owner, "create_bounties", { preparationId: prep.structuredContent.data.preparationId, batchKey: "demo-batch-2026-11" });
  const batchBounties = w.portalStore.all().filter((b) => b.title.startsWith("Batch task"));
  check("J. resume completes the batch without duplicates", resumed.structuredContent.data.counts.published === 10 && batchBounties.length === 10);
  await w.pass(3);

  // ---------- K. funding instructions ----------
  const fund = await tool(owner, "get_funding_instructions", { batchId });
  const rows = fund.structuredContent.data.bounties as any[];
  check("K. 10 distinct deposit addresses, each with its exact amount; total informational", rows.length === 10 && new Set(rows.map((r) => r.depositAddress)).size === 10 && rows.every((r) => r.simulated && r.fundingState === "awaiting-deposit") && fund.structuredContent.data.total.amount === "220.50");
  check("K. nothing funded or transferred by reads or creation", w.tasks.all().filter((t) => batchBounties.some((b) => b.taskId === t.id)).every((t) => !t.funded && t.payment.state === "NotRequested"));

  // ---------- L. new terminal session ----------
  await ada.close();
  await owner.close();
  const adaAgain = await mcp("ada");
  const ownerAgain = await mcp("owner");
  const act = await tool(adaAgain, "list_my_activity", {});
  const batch = await tool(ownerAgain, "get_batch_status", { batchId });
  check("L. a new MCP session reads the same state (payment, batch)", act.structuredContent.data.counts.payments === 1 && batch.structuredContent.data.counts.published === 10);
  // ---------- revocation from the browser, effective on the next MCP call ----------
  {
    const { context, page } = await pageFor("ada");
    await page.goto(`${w.origin}/agent/connect`);
    await page.waitForSelector("#terminals:not([hidden]) button", { state: "visible" });
    await page.screenshot({ path: join(OUT, "M-connected-terminals-1280.png"), fullPage: true });
    await page.click("#terminal-list button");
    await page.waitForFunction(() => /No active terminal credentials/.test(document.getElementById("terminal-list")!.textContent ?? ""));
    await context.close();
    const after = await tool(adaAgain, "account_status");
    check("M. revoked from the browser: the next MCP call returns credential_revoked", after.isError === true && after.structuredContent.error.code === "credential_revoked");
  }
  await adaAgain.close();
  await ownerAgain.close();
} catch (error) {
  check("demo aborted", false, String((error as Error).stack ?? error));
} finally {
  clearInterval(tick);
  await browser.close();
  await w.close();
}
writeFileSync(join(OUT, "results.json"), JSON.stringify({ mode: "simulation (no funds, mock GitHub, simulated escrow chain)", at: new Date().toISOString(), passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }, null, 2));
writeFileSync(join(OUT, "transcript.md"), transcript.join("\n"));
console.error(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed. Evidence in ${OUT}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
