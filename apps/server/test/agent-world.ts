// Test world for the agent (MCP) API: the real services (TaskService, PortalService, FixedBounties,
// ReadModel, RateLimiter, Auth, agent API) on a temporary database, the simulated escrow chain, a
// mock GitHub, and a controllable clock. No network beyond 127.0.0.1, no funds.
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { TaskStore } from "../server/tasks/store.ts";
import { TaskService } from "../server/tasks/service.ts";
import { GitHub } from "../server/tasks/github.ts";
import { SimulatedPayments } from "../server/tasks/payments.ts";
import { PortalStore, digest, type User } from "../server/portal/store.ts";
import { PortalService } from "../server/portal/service.ts";
import { MarketStore } from "../server/portal/market-store.ts";
import { FixedBounties } from "../server/market/fixed.ts";
import { SimChain } from "../server/market/sim-chain.ts";
import { ReadModel } from "../server/portal/read-model.ts";
import { RateLimiter, defaultRules } from "../server/portal/rate-limit.ts";
import { Auth } from "../server/portal/auth.ts";
import { bountyModeCapabilities, setFixedDeadlineRails } from "../server/portal/market-rollout.ts";
import { createAgentApi } from "../server/agent/api.ts";

export const KEY = randomBytes(32);
export const H = 3_600_000;
export const users: Record<string, User> = {
  owner: { id: 1001, login: "acme-owner", name: "Owner", avatar: "", token: "gho_owner", createdAt: "" },
  ada: { id: 2002, login: "dev-ada", name: "Ada", avatar: "", token: "gho_ada", createdAt: "" },
  bo: { id: 2003, login: "dev-bo", name: "Bo", avatar: "", token: "gho_bo", createdAt: "" },
};
export const walletKey = (n: number) => ("0x" + String(n).repeat(64).slice(0, 64)) as `0x${string}`;
export const walletOf = (n: number) => privateKeyToAccount(walletKey(n));

export interface Pr { number: number; user: { id: number }; base: { ref: string; repo: { id: number; full_name: string } }; head: { sha: string }; body: string; state: string; merged: boolean; changed_files: number; additions: number; deletions: number; created_at: string }

export async function agentWorld(options: { path?: string; port?: number; dir?: string; staticDir?: string } = {}) {
  const clock = { now: Date.UTC(2026, 10, 5, 9, 0, 0) };
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "np-agent-"));
  const tasks = new TaskStore(options.path ?? ":memory:");
  const portalStore = new PortalStore(tasks.db, dir, KEY);
  for (const u of Object.values(users)) portalStore.saveUser(u);
  const markets = new MarketStore(tasks.db, portalStore);
  const chain = new SimChain(tasks.db, { now: () => clock.now, funded: (k) => tasks.get(k).funded, escrowCents: (k) => tasks.get(k).policy.amountCents });
  const payments = new SimulatedPayments(tasks, chain);
  const service = new TaskService(tasks, new GitHub({}), payments, { mode: "simulation", githubMode: "fixture", verifier: "sim-verifier", recipient: "r" });

  // ---- mock GitHub (per user credential) ----
  const gh = { calls: [] as string[], prs: new Map<number, Pr>(), issues: [] as any[], failRepo: new Set<string>(), jobs: ["acceptance", "lint"], squashEnabled: true };
  const repos: Record<string, { id: number; owner: number; private: boolean }> = { "acme/widgets": { id: 100, owner: 1001, private: false }, "acme/secret": { id: 101, owner: 1001, private: true }, "other/repo": { id: 200, owner: 9999, private: false } };
  const route = async (u: User, path: string): Promise<unknown> => {
    gh.calls.push(`${u.login} GET ${path}`);
    const fail = (code: number) => { throw new Error(`GitHub read failed (${code})`); };
    const m = /^\/repos\/([\w.-]+\/[\w.-]+)(\/.*)?$/.exec(path.split("?")[0]!);
    if (!m) return fail(404);
    const r = repos[m[1]!];
    if (!r || (r.private && u.id !== r.owner)) return fail(404);
    if (gh.failRepo.has(m[1]!)) return fail(503);
    const rest = m[2] ?? "";
    if (!rest) return { id: r.id, full_name: m[1], private: r.private, permissions: { push: u.id === r.owner }, allow_squash_merge: gh.squashEnabled, archived: false, default_branch: "main" };
    if (rest.startsWith("/git/trees/")) return { tree: [".github/workflows/acceptance.yml", "test/acceptance.test.ts", "package.json", "src/index.ts"].map((p) => ({ path: p, type: "blob" })) };
    if (rest === "/actions/workflows/acceptance.yml") return { id: 7, path: ".github/workflows/acceptance.yml" };
    if (rest === "/actions/workflows/7/runs") return { workflow_runs: [{ id: 70 }] };
    if (rest === "/actions/runs/70/jobs") return { total_count: gh.jobs.length, jobs: gh.jobs.map((name) => ({ name })) };
    if (rest === "/issues") return gh.issues.filter((i) => i.repo === m[1]);
    const pull = /^\/pulls\/(\d+)$/.exec(rest);
    if (pull) return gh.prs.has(Number(pull[1])) && r.id === gh.prs.get(Number(pull[1]))!.base.repo.id ? structuredClone(gh.prs.get(Number(pull[1]))) : fail(404);
    if (rest.startsWith("/pulls")) return [];
    return fail(404);
  };
  const githubFor = (u: User) => ({ get: async <T>(path: string) => (await route(u, path)) as T, evidence: async () => { throw new Error("not used"); } }) as any;
  const write = async <T>(u: User, path: string, method: string, body: any) => {
    gh.calls.push(`${u.login} ${method} ${path}`);
    const repo = /^\/repos\/([\w.-]+\/[\w.-]+)\/issues$/.exec(path)?.[1];
    if (repo && method === "POST") {
      const issue = { number: 40 + gh.issues.length + 1, html_url: `https://github.com/${repo}/issues/${41 + gh.issues.length}`, body: body.body, repo };
      gh.issues.push(issue);
      return issue as T;
    }
    throw new Error("Unexpected GitHub write in test: " + path);
  };
  const portal = new PortalService(portalStore, service, githubFor, write as any);
  const fixed = new FixedBounties({ markets, tasks: service, rail: async (t) => payments.market(t), ownerGitHub: (id) => githubFor(portalStore.user(id)!), environment: "simulation", now: () => clock.now });
  service.lifecycle = fixed;
  portal.fixed = fixed;
  setFixedDeadlineRails({ bank: true, "base-usdc": true }, "Simulation: deadline bounties run on the simulated escrow chain; no funds move.");
  const reads = new ReadModel(portalStore, tasks, bountyModeCapabilities);
  const limiter = new RateLimiter({ ...defaultRules(), mutation: { limit: 1000, windowMs: 60_000 }, read: { limit: 5000, windowMs: 60_000 }, "expensive-read": { limit: 500, windowMs: 60_000 }, wallet: { limit: 200, windowMs: 60_000 }, auth: { limit: 2000, windowMs: 60_000 } }, 50_000, () => clock.now);

  // ---- HTTP server ----
  let api: ReturnType<typeof createAgentApi>;
  let auth: Auth;
  const server: Server = createServer((req, res) => {
    // The real /api/portal/me (portal/http.ts) for the fields the agent pages read: user + CSRF.
    if (req.url === "/api/portal/me" && req.method === "GET") {
      const session = auth.session(req);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ user: session ? { id: session.user.id, login: session.user.login, avatar: session.user.avatar, name: session.user.name } : null, csrf: session?.csrf ?? null, localPreview: false }));
      return;
    }
    api.handler(req, res).then((handled) => {
      if (handled) return;
      // Optional static assets (fonts, brand images) for page screenshots in the demo.
      const file = options.staticDir && /^\/(?:fonts|brand)\/[\w./-]+$/.test(req.url ?? "") && !(req.url ?? "").includes("..") ? join(options.staticDir, req.url!) : null;
      if (file && existsSync(file)) {
        res.writeHead(200, { "Content-Type": file.endsWith(".png") ? "image/png" : file.endsWith(".ttf") ? "font/ttf" : "application/octet-stream" });
        res.end(readFileSync(file));
        return;
      }
      res.writeHead(404);
      res.end();
    }, (e) => {
      res.writeHead(500);
      res.end(String(e));
    });
  });
  await new Promise<void>((ok) => server.listen(options.port ?? 0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  process.env.APP_ORIGIN = origin;
  auth = new Auth(portalStore);
  api = createAgentApi({
    store: portalStore, tasks: service, portal, fixed, reads, limiter, clientIp: () => "127.0.0.1", auth,
    allowedRepo: async (u, repo) => { try { await route(u, `/repos/${repo}`); return true; } catch { return false; } },
    deposit: (t) => payments.deposit(t) as Promise<Record<string, unknown>>,
    publishGuard: (u, b) => { if (u.id !== b.ownerId) throw new Error("Only the client can publish this bounty"); },
    capabilities: bountyModeCapabilities, mode: "simulation", usdcReady: () => true, now: () => clock.now,
  });

  // ---- sessions (as after GitHub OAuth) ----
  const sessions: Record<string, { cookie: string; csrf: string }> = {};
  for (const [name, u] of Object.entries(users)) {
    const token = randomBytes(24).toString("base64url"), csrf = randomBytes(24).toString("base64url");
    tasks.db.prepare("INSERT INTO portal_sessions VALUES(?,?,?,?)").run(digest(token), u.id, csrf, Date.now() + 86_400_000 * 365);
    sessions[name] = { cookie: `np_session=${token}`, csrf };
  }
  const call = async (method: string, path: string, o: { bearer?: string; session?: string; body?: unknown; csrf?: boolean; origin?: string } = {}) => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`;
    if (o.session) headers.Cookie = sessions[o.session]!.cookie;
    if (o.session && o.csrf !== false && method === "POST") headers["X-CSRF-Token"] = sessions[o.session]!.csrf;
    if (method === "POST") headers.Origin = o.origin ?? origin;
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(origin + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const data = (await r.json().catch(() => null)) as any;
    return { status: r.status, body: data, data: data?.data, error: data?.error, headers: r.headers };
  };
  /** Full device flow: start (CLI) → human decision in the browser session → token poll (CLI). */
  const login = async (who: string, scopes: string[] = ["read", "contribute", "create"], approve: string[] = scopes) => {
    const start = await call("POST", "/api/agent/device/code", { body: { clientName: "test client", scopes } });
    const decision = await call("POST", "/api/agent/device/decision", { session: who, body: { code: start.data.userCode, decision: "approve", scopes: approve } });
    if (decision.status !== 200) throw new Error("approval failed: " + JSON.stringify(decision.body));
    const token = await call("POST", "/api/agent/device/token", { body: { deviceCode: start.data.deviceCode } });
    if (token.data?.status !== "approved") throw new Error("token failed: " + JSON.stringify(token.body));
    return token.data.accessToken as string;
  };
  /** Wallet verification as the browser page does it: bearer start → session signature. */
  const verifyWallet = async (who: string, bearer: string, n: number) => {
    const account = walletOf(n);
    const started = await call("POST", "/api/agent/v1/wallets/verify", { bearer, body: { address: account.address } });
    if (started.data.verified) return account.address.toLowerCase();
    const page = await call("GET", `/api/agent/session/wallet-requests/${started.data.requestId}`, { session: who });
    const signature = await account.signMessage({ message: page.data.message });
    const done = await call("POST", `/api/agent/session/wallet-requests/${started.data.requestId}/verify`, { session: who, body: { signature } });
    if (done.status !== 200) throw new Error("wallet failed: " + JSON.stringify(done.body));
    return account.address.toLowerCase();
  };
  /** Worker passes (task worker + portal jobs), as the server's intervals do. */
  const pass = async (times = 1) => {
    for (let i = 0; i < times; i++) {
      for (const t of tasks.all()) tasks.enqueue(t.id);
      await service.tick();
      await portal.tick();
    }
  };
  const item = (i: number, patch: Record<string, unknown> = {}) => ({ repository: "acme/widgets", title: `Task ${i}: improve module ${i}`, description: `Implement improvement ${i} with tests.`, criteria: [`Criterion ${i}a`, `Criterion ${i}b`], workflowPath: ".github/workflows/acceptance.yml", jobs: ["acceptance"], protectedPaths: ["test/acceptance.test.ts"], rewardUsdc: "25", delivery: { hours: 48 }, clientRef: `item-${i}`, ...patch });
  /** Create, publish and (optionally) fund one USDC fixed bounty through the agent API. */
  const bounty = async (ownerToken: string, patch: Record<string, unknown> = {}, fund = true) => {
    const prep = await call("POST", "/api/agent/v1/prepare", { bearer: ownerToken, body: { items: [item(Math.floor(Math.random() * 1e9), patch)] } });
    if (!prep.data?.preparationId) throw new Error("prepare failed: " + JSON.stringify(prep.body));
    const created = await call("POST", "/api/agent/v1/batches", { bearer: ownerToken, body: { preparationId: prep.data.preparationId } });
    const id = created.data.items[0].bountyId as string;
    await pass(2);
    if (fund) {
      const b = portalStore.bounty(id);
      service.fund(tasks.get(b.taskId!));
      await pass(3);
    }
    return portalStore.bounty(id);
  };
  const pr = (n: number, who: User, marker: string, patch: Partial<Pr> = {}) => {
    gh.prs.set(n, { number: n, user: { id: who.id }, base: { ref: "main", repo: { id: 100, full_name: "acme/widgets" } }, head: { sha: "a".repeat(40) }, body: `Work.\n\nNearPortal-Task: ${marker}`, state: "open", merged: false, changed_files: 2, additions: 10, deletions: 1, created_at: new Date(clock.now).toISOString(), ...patch });
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
    tasks.close();
  };
  return { clock, dir, tasks, portalStore, markets, chain, payments, service, portal, fixed, reads, gh, origin, port, api, call, login, verifyWallet, pass, item, bounty, pr, sessions, close };
}
export type AgentWorld = Awaited<ReturnType<typeof agentWorld>>;
