import { STATUSES } from "../../src/workspace/workspace-model.mjs";
import { deadlineWindow } from "./deadline-window.ts";
import { note } from "../tasks/domain.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TaskService } from "../tasks/service.ts";
import { readBody } from "../tasks/http.ts";
import { PortalStore, identity, digest } from "./store.ts";
import { Auth } from "./auth.ts";
import { OAuthTokens } from "./oauth-tokens.ts";
import { PortalService } from "./service.ts";
import { git, ghWrite, repositories } from "./github.ts";
import { sandboxPayments, type PaymentAdapter } from "../tasks/payments.ts";
import { maintenanceEnabled, maintenanceGate, MAINTENANCE_MESSAGE } from "../ops/maintenance.ts";
import { bankPaymentsEnabled, BANK_DISABLED_MESSAGE } from "../ops/payment-rails.ts";
import { SimulatedPayments } from "../tasks/payments.ts";
import { hasTaskMarker, preparedPrUrl } from "./judge.ts";
import { workflowChecks } from "./workflow-checks.ts";
import { verificationFiles } from "./verification-files.ts";
import { createDemoTreasury } from "./treasury.ts";
import { cryptoPayments } from "../crypto/payments.ts";
import { createWalletProof, verifyWalletProof } from "../crypto/wallet-proof.ts";
import { bountyModeCapabilities, railVerified, setFixedDeadlineRails } from "./market-rollout.ts";
import { FixedBounties } from "../market/fixed.ts";
import { MarketStore } from "./market-store.ts";
import { RateLimiter, categorize, makeClientIp } from "./rate-limit.ts";
import { ReadModel, type Scope } from "./read-model.ts";
import { TtlCache, gate, allGates, ProviderFailure, ProviderUnavailable } from "../ops/provider.ts";
import { metrics } from "../ops/metrics.ts";
import { StaleWriteError } from "../tasks/store.ts";
import { StaleBountyError } from "./store.ts";
import { createAgentApi } from "../agent/api.ts";

const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(data));
};
const body = async (req: IncomingMessage) => {
  const value = JSON.parse((await readBody(req, 64_000)).toString() || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid request body");
  return value as Record<string, unknown>;
};

export async function portalRuntime(
  tasks: TaskService,
  options: { githubFor?: typeof git; write?: typeof ghWrite } = {},
) {
  const { env } = await import("../env.ts");
  const store = new PortalStore(
    tasks.store.db,
    env.dataDir,
    process.env.PORTAL_ENCRYPTION_KEY
      ? Buffer.from(process.env.PORTAL_ENCRYPTION_KEY, "base64")
      : undefined,
  );
  const oauthTokens = new OAuthTokens(store);
  const githubFor: typeof git = options.githubFor ?? ((u) => git(u, () => oauthTokens.token(u.id)));
  const write: typeof ghWrite = options.write ?? ((u, path, method, body) => githubFor(u).write(path, method, body));
  const auth = new Auth(store),
    portal = new PortalService(store, tasks, githubFor, write);
  let openBountyReady = tasks.config.mode !== "sandbox";
  if (
    tasks.config.mode === "sandbox" && bankPaymentsEnabled() &&
    process.env.PORTAL_OPEN_BOUNTY_ENABLED === "1"
  ) {
    try {
      const { view } = await import("../chain.ts");
      const config = await view<{owner:string;operators:string[];verifier:string;relayer:string;max_reward_cents:string;paused:boolean}>("get_config");
      if (config.owner !== env.owner || config.verifier !== process.env.GITHUB_VERIFIER_ACCOUNT_ID ||
          config.relayer !== env.relayer || !config.operators?.includes(env.client) ||
          !/^[1-9][0-9]*$/.test(config.max_reward_cents ?? "") || config.paused)
        throw new Error("Bank deployment configuration mismatch");
      if (await view("get_bounty", { bounty_id: "18446744073709551615" }) !== null)
        throw new Error("Bank deployment interface mismatch");
      openBountyReady = true;
    } catch {
      /* Tested extension awaits approved deployment. */
    }
  }
  // Bring the already verified rehearsal into the operator's authenticated workspace.
  // This creates local dashboard records only, never issues or new escrow transactions.

  if (
    process.env.PORTAL_OPERATOR_GITHUB_ID &&
    /^[1-9][0-9]*$/.test(process.env.PORTAL_OPERATOR_GITHUB_ID)
  )
    store.meta("operator", process.env.PORTAL_OPERATOR_GITHUB_ID);
  if (process.env.GITHUB_USE_CLI === "1" && !store.meta("operator")) {
    try {
      const account = await tasks.github.get<{ id: number }>("/user");
      store.meta("operator", String(account.id));
    } catch {
      /* OAuth setup remains usable without the CLI. */
    }
  }
  const operatorId = Number(store.meta("operator"));
  if (operatorId) {
    for (const t of tasks.store.all()) {
      if (t.portalId || !t.policy.mergerIds.includes(operatorId)) continue;
      const id = t.id,
        code = `NP-${t.id.replaceAll("-", "").slice(0, 10).toUpperCase()}`;
      if (store.all().some((b) => b.taskId === t.id)) continue;
      store.save({
        id,
        code,
        ownerId: operatorId,
        owner:
          store.user(operatorId)?.login ?? t.policy.repository.split("/")[0]!,
        repository: t.policy.repository,
        private: true,
        title: t.policy.title,
        description:
          "Verified end-to-end GitHub reward rehearsal. The client funds escrow, a separate developer contributes, and payment follows the agreed merge policy.",
        criteria: t.policy.criteria,
        amountCents: t.policy.amountCents,
        branch: t.policy.branch,
        checkName: t.policy.checks[0]?.name ?? "acceptance",
        checkAppId: t.policy.checks[0]?.appId ?? 15368,
        workflowPath: t.policy.workflowPath,
        protectedPaths: t.policy.protectedFiles
          .filter((f) => f.path !== t.policy.workflowPath)
          .map((f) => f.path)
          .join("\n"),
        taskId: t.id,
        issueNumber: null,
        issueUrl: null,
        status: t.payment.state === "Processed" ? "Paid" : "Blocked",
        published: true,
        error: null,
        createdAt: t.createdAt,
        updatedAt: t.createdAt,
      });
    }
  }
  // Evidence is always fetched with the funded repository owner's authorization.
  const legacyEvidence = tasks.github.evidence.bind(tasks.github);
  tasks.github.evidence = (t) =>
    t.ownerId ? portal.userGit(t.ownerId).evidence(t) : legacyEvidence(t);
  const legacyPayments = tasks.payments;
  const treasury = createDemoTreasury(tasks, store);
  let cryptoReady = false;
  if(tasks.config.mode==="sandbox" && process.env.CRYPTO_USDC_ENABLED==="1") {
    try { const {view}=await import("../chain.ts"); const contract=process.env.CRYPTO_ESCROW_CONTRACT_ID; if(!contract || contract===env.contractId || !contract.endsWith(".testnet")) throw new Error("Isolated crypto contract required");
      const config=await view<{operators:string[];verifier:string;relayer:string}>("get_config",{},contract);
      if(!config.operators?.includes(process.env.CRYPTO_CLIENT_ACCOUNT_ID!) || config.verifier!==process.env.CRYPTO_VERIFIER_ACCOUNT_ID || config.relayer!==process.env.CRYPTO_RELAYER_ACCOUNT_ID) throw new Error("Crypto role configuration mismatch");
      await view("get_bounty",{bounty_id:"00000000-0000-0000-0000-000000000000"},contract); cryptoReady=true; } catch { /* Fail closed until approved deployment exists. */ }
  }
  const cryptoAdapter=cryptoPayments(tasks.store,store);
  const adapters = new Map<string, Promise<PaymentAdapter>>();
  const adapter = async (t: Parameters<PaymentAdapter["prepare"]>[0]) => {
    if (maintenanceEnabled()) return legacyPayments;
    // Simulation mode simulates both rails (no chain, no funds); sandbox needs the verified USDC contract.
    if(t.policy.paymentRail === "base-usdc" && tasks.config.mode === "simulation") return legacyPayments;
    if(t.policy.paymentRail === "base-usdc") { if(!cryptoReady) throw new Error("USDC test payments are not enabled on this deployment"); return cryptoAdapter; }
    if (!bankPaymentsEnabled()) throw new Error(BANK_DISABLED_MESSAGE);
    if (!t.ownerId || tasks.config.mode !== "sandbox") return legacyPayments;
    const user = store.user(t.ownerId);
    if (!user?.bank && String(t.ownerId) === store.meta("operator"))
      return legacyPayments;
    if (!user?.bank)
      throw new Error(
        "The client must connect their Monerium sandbox account in Settings",
      );
    const key = `${user.id}:${digest(user.bank.clientId + ":" + user.bank.clientSecret)}`;
    if (!adapters.has(key)) {
      const pending = sandboxPayments(tasks.store, {
        ...user.bank,
        ownerId: user.id,
      });
      adapters.set(key, pending);
      pending.catch(() => {
        adapters.delete(key);
      });
    }
    return adapters.get(key)!;
  };
  // Keep the proven adapter for legacy tasks; isolate each new client's bank credentials.
  const routed: PaymentAdapter = {
    prepare: async (t) => (await adapter(t)).prepare(t),
    sync: async (t) => (await adapter(t)).sync(t),
    release: async (t) => (await adapter(t)).release(t),
    dispute: async (t, r) => (await adapter(t)).dispute(t, r),
    deposit: async (t) => (await adapter(t)).deposit(t),
  };
  Object.assign(tasks, { payments: routed });
  // Fixed price + deadline: one lifecycle for both rails, installed in the task worker.
  const markets = new MarketStore(store.db, store);
  const fixed = new FixedBounties({
    markets,
    tasks,
    rail: async (t) => {
      const a = await adapter(t);
      return a.market?.(t) ?? null;
    },
    ownerGitHub: (ownerId) => portal.userGit(ownerId),
    environment: tasks.config.mode === "sandbox" ? `sandbox:${env.network}` : "simulation",
  });
  portal.fixed = fixed;
  tasks.lifecycle = fixed;
  // Capability per rail from verified facts: simulation, or the deployed code hash is allowlisted.
  {
    let bankHash: string | null = null, cryptoHash: string | null = null;
    if (tasks.config.mode === "sandbox") {
      const codeHash = async (account: string | undefined) => {
        if (!account) return null;
        try {
          const rpc = env.nearRpc.split(",")[0]!.trim();
          const r = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "np", method: "query", params: { request_type: "view_account", finality: "final", account_id: account } }), signal: AbortSignal.timeout(10_000) });
          return ((await r.json()) as { result?: { code_hash?: string } }).result?.code_hash ?? null;
        } catch { return null; }
      };
      [bankHash, cryptoHash] = await Promise.all([bankPaymentsEnabled() ? codeHash(env.contractId) : Promise.resolve(null), cryptoReady ? codeHash(process.env.CRYPTO_ESCROW_CONTRACT_ID) : Promise.resolve(null)]);
    }
    const rails = { bank: bankPaymentsEnabled() && openBountyReady && railVerified(tasks.config.mode, bankHash), "base-usdc": tasks.config.mode === "simulation" || (cryptoReady && railVerified(tasks.config.mode, cryptoHash)) };
    setFixedDeadlineRails(rails, tasks.config.mode === "simulation" ? "Simulation: deadline bounties run on the simulated escrow chain; no funds move." : rails.bank || rails["base-usdc"] ? "Enabled for the rails whose deployed escrow code was verified." : "The deployed escrow contracts do not have verified deadline support yet.");
    if (maintenanceEnabled()) setFixedDeadlineRails({ bank: false, "base-usdc": false }, MAINTENANCE_MESSAGE);
  }
  // Repository membership per user *and credential*: a reconnected token never reuses an old
  // (e.g. 401) answer, and one user's access is never applied to another. Positive answers last
  // longer than negative ones; concurrent checks for the same key share one GitHub request.
  type Access = { allowed: boolean; issue: "reconnect" | "access-required" | "unavailable" | null };
  const membership = new TtlCache<Access>(20_000);
  const membershipInflight = new Map<string, Promise<Access>>();
  const membershipKey = (u: import("./store.ts").User, repo: string) => `${u.id}:${digest(`${Boolean(u.local)}:${u.token}`)}:${repo}`;
  async function allowedRepo(
    u: import("./store.ts").User,
    repo: string,
    fresh = false,
  ) {
    const key = membershipKey(u, repo);
    const hit = membership.get(key);
    if (!fresh && hit) return hit.allowed;
    let pending = membershipInflight.get(key);
    if (!pending) {
      pending = (async (): Promise<Access> => {
        try {
          await portal.githubFor(u).get(`/repos/${repo}`);
          return { allowed: true, issue: null };
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          return { allowed: false, issue: /\(401\)/.test(message) ? "reconnect" : /\(404\)/.test(message) ? "access-required" : "unavailable" };
        }
      })();
      membershipInflight.set(key, pending);
      pending.finally(() => membershipInflight.delete(key));
    }
    const result = await pending;
    // Transient provider trouble is not cached; definite answers are.
    if (result.issue !== "unavailable") membership.set(key, result, result.allowed ? 300_000 : 30_000);
    return result.allowed;
  }
  const cachedMember = (u: import("./store.ts").User, repo: string) => membership.get(membershipKey(u, repo))?.allowed ?? false;
  const accessIssue = (u: import("./store.ts").User, repo: string) => membership.get(membershipKey(u, repo))?.issue ?? "unavailable";
  const limiter = new RateLimiter();
  const clientIp = makeClientIp();
  const reads = new ReadModel(store, tasks.store, bountyModeCapabilities);
  // Backend-side caches for provider-backed reads that are safe to reuse (never used to move funds).
  const depositCache = new TtlCache<unknown>(2000);
  const treasuryCache = new TtlCache<unknown>(200);
  // Display data only (the worker confirms funding from the chain): a short backend cache keyed by
  // the funding agreement spares Monerium/RPC. Shared by the site and the agent API.
  async function cachedDeposit(t: import("../tasks/domain.ts").Task) {
    const depositKey = `${t.id}:${t.jobId}:${t.fundingPolicyHash ?? t.policyHash}:${t.clientAccepted ? 1 : 0}`;
    let instructions = depositCache.get(depositKey) as Record<string, unknown> | undefined;
    if (!instructions) {
      instructions = (await tasks.payments.deposit(t)) as unknown as Record<string, unknown>;
      const complete = Boolean(instructions.iban || instructions.address);
      depositCache.set(depositKey, instructions, complete ? 300_000 : 15_000);
    }
    return instructions;
  }
  /** Deployment checks behind Publish, shared by the site route and agent batches. */
  function publishGuard(user: import("./store.ts").User, b: import("./store.ts").Bounty) {
    if (user.id !== b.ownerId) throw new Error("Only the client can publish this bounty");
    if (b.paymentRail === "base-usdc" && !cryptoReady && tasks.config.mode !== "simulation") throw new Error("USDC test payments await contract deployment and validation. Your draft is saved.");
    if (b.paymentRail !== "base-usdc" && !bankPaymentsEnabled()) throw new Error(BANK_DISABLED_MESSAGE);
    if (b.paymentRail !== "base-usdc" && !openBountyReady) throw new Error("The tested open-bounty contract extension is awaiting deployment approval. Your draft is saved; funding has not started.");
    if (b.paymentRail !== "base-usdc" && !user.bank && String(user.id) !== store.meta("operator") && tasks.config.mode === "sandbox")
      throw new Error("Connect Monerium in Settings before publishing");
  }
  const moneriumGate = gate("monerium", { concurrency: 2, hourlyBudget: 1200, timeoutMs: 20_000 });
  const sendLimited = (res: ServerResponse, retryAfterSeconds: number, message = "Too many requests. Please wait a moment.") => {
    res.writeHead(429, { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": String(retryAfterSeconds), "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify({ error: message, retryAfterSeconds }));
  };
  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", auth.origin);
    if (
      !url.pathname.startsWith("/api/portal") &&
      !url.pathname.startsWith("/auth/")
    )
      return false;
    if (maintenanceGate(req, res)) return true;
    try {
      const path = url.pathname.replace("/api/portal", "");
      // Health probes are exempt from quotas so the orchestrator never sees a false outage.
      if ((path === "/health" || path === "/livez" || path === "/readyz") && req.method === "GET") {
        const ready = readiness();
        json(res, path === "/livez" ? 200 : ready.ready ? 200 : 503, path === "/livez" ? { status: "alive" } : ready);
        return true;
      }
      const ip = clientIp(req);
      const ceiling = limiter.take("ip-ceiling", ip);
      if (!ceiling.ok) {
        sendLimited(res, ceiling.retryAfterSeconds);
        return true;
      }
      const { category, perUser } = categorize(req.method ?? "GET", url.pathname);
      const sessionUser = perUser ? auth.session(req)?.user : undefined;
      // Signed-in users get their own quota per category; anonymous visitors are limited per IP.
      const quota = sessionUser ? limiter.take(category, `u${sessionUser.id}`) : limiter.take(perUser ? (req.method === "GET" ? "anon-read" : "auth") : category, ip);
      if (!quota.ok) {
        sendLimited(res, quota.retryAfterSeconds);
        return true;
      }
      if (await auth.route(req, res, url)) return true;
      if (path === "/me" && req.method === "GET") {
        const session = auth.session(req);
        const u = session?.user;
        json(res, 200, {
          user: u ? identity(u) : null,
          csrf: session?.csrf ?? null,
          oauthConfigured: auth.configured,
          localPreview: auth.preview,
          maintenance: maintenanceEnabled(),
          demoTreasuryAvailable: !maintenanceEnabled() && Boolean(u && treasury.allowed(u.id)),
          mode: tasks.config.mode,
          openBountyReady: !maintenanceEnabled() && openBountyReady,
          bountyModeCapabilities,
          cryptoPaymentsReady: !maintenanceEnabled() && cryptoReady,
          githubMode: tasks.config.githubMode,
          bankConnected: Boolean(
            bankPaymentsEnabled() && u &&
              (u.bank ||
                (String(u.id) === store.meta("operator") &&
                  env.monerium.clientId &&
                  env.monerium.clientSecret)),
          ),
          payout: u?.payout
            ? {
                name: `${u.payout.firstName} ${u.payout.lastName}`,
                iban: `${u.payout.iban?.slice(0, 4)}…${u.payout.iban?.slice(-4)}`,
                country: u.payout.country,
                version: u.payout.version,
              }
            : null,
        });
        return true;
      }
      if (path === "/local-login" && req.method === "POST") {
        json(res, 200, { user: await auth.localLogin(req, res) });
        return true;
      }
      const u = auth.session(req)?.user;
      if ((path === "/home" || path === "/leaderboard") && req.method === "GET") {
        const filter=url.searchParams.get("status")||"",page=Number(url.searchParams.get("page")||1);
        if(filter && !Object.hasOwn(STATUSES,filter))throw new Error('Unknown bounty status');
        if(!Number.isSafeInteger(page)||page<1||page>10_000)throw new Error('Invalid ranking page');
        const snapshot=reads.home(u?.id,filter,page);
        if(path==="/leaderboard")json(res,200,{...snapshot.ranking,updatedAt:snapshot.updatedAt});
        else {
          const {ranking,...home}=snapshot;
          // Five local projections at most; no provider calls and no extra browser requests.
          const rows=home.rows.map(row=>({...row,deadlineWindow:deadlineWindow(fixed.view(store.bounty(row.id),u?.id))}));
          json(res,200,{...home,rows});
        }
        return true;
      }

      if (path === "/judge-demo" && req.method === "GET") {
        const configured =
          portal.judge.enabled && tasks.config.mode === "sandbox";
        const pool = configured
          ? store
              .all()
              .filter(
                (b) =>
                  b.published &&
                  !b.private &&
                  b.repository === portal.judge.repository &&
                  portal.judge.tasks[b.id],
              )
          : [];
        const proof = store.all().find((b) => {
          const t = portal.task(b);
          return (
            (!portal.judge.proofId || b.id === portal.judge.proofId) &&
            b.published &&
            t?.mode === "sandbox" &&
            t.githubMode === "live" &&
            t.payment.state === "Processed"
          );
        });
        json(res, 200, {
          enabled: configured,
          autoMerge: configured && portal.judge.autoMerge,
          bounties: pool.map((b) => portal.public(b, u)),
          proof: proof ? portal.public(proof, u) : null,
          demoRecipient:
            configured && process.env.PORTAL_JUDGE_PAYOUT_IBAN
              ? `${process.env.PORTAL_JUDGE_PAYOUT_IBAN.slice(0, 4)}…${process.env.PORTAL_JUDGE_PAYOUT_IBAN.slice(-4)}`
              : null,
        });
        return true;
      }
      if (path === "/bounties" && req.method === "GET") {
        // Server-side scope, filters and pagination; responses are bounded by MAX_PAGE_SIZE.
        const scope = (url.searchParams.get("scope") || "all") as Scope;
        if (!["mine", "work", "explore", "all"].includes(scope)) throw new Error("Unknown bounty scope");
        if ((scope === "mine" || scope === "work") && !u) throw new Error("Sign in with GitHub to continue");
        const result = reads.page({
          userId: u?.id,
          scope,
          status: url.searchParams.get("status") || undefined,
          q: url.searchParams.get("q") || undefined,
          repository: url.searchParams.get("repository") || undefined,
          page: Number(url.searchParams.get("page") || 1),
          limit: Number(url.searchParams.get("limit") || 50),
        }, (b) => portal.canRead(b, u));
        // Lists never call GitHub per visitor: membership is only reused from the cache (a private
        // non-member sees the same card either way; evidence is shown on the detail page).
        json(res, 200, {
          bounties: result.items.map((b) => portal.summary(b, u, Boolean(u && cachedMember(u, b.repository)), reads.task(b))),
          scope,
          page: result.page,
          pages: result.pages,
          total: result.total,
          limit: result.limit,
          counts: result.counts,
          repositories: result.repositories,
        });
        return true;
      }
      const match =
        /^\/bounties\/([a-f0-9-]{36}|NP-[A-F0-9]{10})(?:\/(publish|claim|deposit|pr|refresh|simulate-fund|dispute|edit|request-access|invite|check-access|prepare-judge-pr|treasury-fund|wallet-challenge|accept-work|submit|withdraw))?$/.exec(
          path,
        );
      if (match) {
        const b = store.bounty(match[1]!);
        if (!portal.canRead(b, u)) throw new Error("Bounty not found");
        if (req.method === "GET" && !match[2]) {
          const member = Boolean(
            u && b.private && (await allowedRepo(u, b.repository)),
          );
          json(res, 200, { bounty: { ...portal.public(b, u, member), repositoryAccessIssue: b.private && u && u.id !== b.ownerId && !member ? accessIssue(u, b.repository) : null } });
          return true;
        }
        const user = auth.require(req, req.method !== "GET");
        if (req.method === "GET" && match[2] === "deposit") {
          if (b.ownerId !== user.id)
            throw new Error("Only the client can view funding instructions");
          const t = portal.task(b);
          if (!t) {
            json(res, 200, { iban: null, reference: b.code });
            return true;
          }
          // Instructions are display data (the worker confirms funding from the chain), so a short
          // backend cache keyed by the funding agreement is safe and spares Monerium/RPC.
          json(res, 200, await cachedDeposit(t));
          return true;
        }
        if (req.method !== "POST") throw new Error("Method not allowed");
        const input = await body(req);
        if (match[2] === "treasury-fund") {
          if (typeof input.policyHash !== "string") throw new Error("Review the current funding agreement");
          const funding = await treasury.fund(user.id, b, input.policyHash);
          json(res, 202, { funding });
          return true;
        } else if (match[2] === "prepare-judge-pr") {
          const t = portal.task(b),
            prepared = portal.judge.tasks[b.id];
          if (
            !portal.judge.enabled ||
            tasks.config.mode !== "sandbox" ||
            b.private ||
            !b.published ||
            b.repository !== portal.judge.repository ||
            !prepared ||
            !t?.funded ||
            !t.developerAccepted ||
            t.policy.developerId !== user.id ||
            t.disputed ||
            t.prNumber ||
            t.payment.state !== "NotRequested"
          )
            throw new Error("Prepared demo submission is unavailable");
          const repo = await portal
            .userGit(b.ownerId)
            .get<any>(`/repos/${b.repository}`);
          if (repo.private || repo.id !== t.policy.repositoryId)
            throw new Error("The judge repository must still be public");
          const forkName = `${user.login}/${b.repository.split("/")[1]}`;
          const github = portal.githubFor(user);
          let fork: any;
          try {
            fork = await github.get(`/repos/${forkName}`);
          } catch (error) {
            if (!/404/.test(String(error))) throw error;
          }
          if (!fork) {
            const key = `judge-fork:${b.repository}:${user.id}`;
            if (!store.meta(key)) {
              store.meta(key, "requested");
              await portal.write(user, `/repos/${b.repository}/forks`, "POST", {
                default_branch_only: false,
              });
            }
            json(res, 202, {
              pending: true,
              message:
                "GitHub is preparing your fork. Check again in a few seconds. An uncertain fork request is reconciled rather than duplicated.",
            });
            return true;
          }
          if (
            !fork.fork ||
            fork.owner?.id !== user.id ||
            fork.parent?.id !== repo.id
          )
            throw new Error(
              "Your repository with this name is not a fork of the judge demo. Fork it on GitHub before continuing.",
            );
          let ref: any;
          try {
            ref = await github.get(
              `/repos/${forkName}/git/ref/heads/${encodeURIComponent(prepared.branch)}`,
            );
          } catch (error) {
            if (!/404/.test(String(error))) throw error;
          }
          if (!ref)
            ref = await portal.write(
              user,
              `/repos/${forkName}/git/refs`,
              "POST",
              { ref: `refs/heads/${prepared.branch}`, sha: prepared.headSha },
            );
          if (ref.object?.sha !== prepared.headSha)
            throw new Error(
              "The prepared branch in your fork changed. Use the exact configured demo commit.",
            );
          json(res, 200, {
            url: preparedPrUrl(
              b.repository,
              b.branch,
              prepared,
              b.code,
              b.title,
              user.login,
            ),
          });
          return true;
        } else if (match[2] === "request-access") {
          const t = portal.task(b);
          if (
            !b.private ||
            !b.published ||
            user.id === b.ownerId ||
            !t?.funded ||
            t.policy.developerId
          )
            throw new Error("Access requests are unavailable for this bounty");
          if (!(await allowedRepo(user, b.repository, true)))
            store.requestAccess(b, user);
        } else if (match[2] === "invite") {
          if (user.id !== b.ownerId)
            throw new Error("Only the client can invite contributors");
          const request = store
            .accessRequests(b.id)
            .find((r) => r.userId === input.userId);
          if (!b.private || !request || input.permission !== "push")
            throw new Error(
              "Review the requested GitHub identity and Write permission before inviting",
            );
          if (request.status === "requested") {
            await portal.write(
              user,
              `/repos/${b.repository}/collaborators/${encodeURIComponent(request.login)}`,
              "PUT",
              { permission: "push" },
            );
            store.invited(b.id, request.userId);
          }
        } else if (match[2] === "check-access") {
          if (await allowedRepo(user, b.repository, true))
            store.accepted(b.id, user.id);
        } else if (match[2] === "edit") {
          await portal.create(user, input, b);
        } else if (match[2] === "dispute") {
          const t = portal.task(b);
          if (!t || ![b.ownerId, t.policy.developerId].includes(user.id))
            throw new Error("Only a task participant can raise a dispute");
          await tasks.exclusive(`task:${t.id}`, async () => {
            await tasks.dispute(
              tasks.store.get(t.id),
              user.id === b.ownerId ? "client" : "developer",
            );
            // The agreement pauses too: no expiry, reassignment or release until resolution.
            if (markets.find(b.id)) markets.applyLatest(b.id, { type: "pause" }, Date.now());
          });
        } else if (match[2] === "wallet-challenge") {
          const t=portal.task(b);
          if((!cryptoReady && tasks.config.mode !== "simulation") || b.paymentRail!=="base-usdc" || !t || !t.funded || t.policy.developerId || b.ownerId===user.id) throw new Error("This USDC bounty is not available to claim");
          if(b.private && !(await allowedRepo(user,b.repository,true))) throw new Error("Repository access required");
          json(res,200,createWalletProof(store,user.id,b.id,t.policyHash,input.walletAddress,auth.origin));return true;
        } else if (match[2] === "publish") {
          publishGuard(user, b);
          if (typeof input.revision !== "string")
            throw new Error("Review the current agreement before publishing");
          portal.publish(user, b, input.revision);
        } else if (match[2] === "claim" && b.marketTerms?.kind === "fixed") {
          // Exclusive fixed-deadline claim: authenticated user, private-repo access re-checked,
          // server-owned destination for the bounty's rail, accepted funded terms, one winner.
          const t = portal.task(b);
          if (!t || !b.published) throw new Error("This bounty is not ready");
          if (user.id === b.ownerId) throw new Error("The client cannot claim their own bounty");
          const access = !b.private || (await allowedRepo(user, b.repository, true));
          if (!access) throw new Error("Repository access is required before claiming");
          await tasks.exclusive(`task:${t.id}`, async () => {
            if (b.paymentRail === "base-usdc") {
              if (!cryptoReady && tasks.config.mode !== "simulation") throw new Error("USDC test payments unavailable");
              const current = tasks.store.get(t.id);
              const proof = await verifyWalletProof(store, user.id, b.id, current.policyHash, input);
              fixed.claim(b, user, { acceptedPolicyHash: input.policyHash, expectedRevision: input.expectedRevision }, { kind: "usdc", address: proof.address, proofVersion: digest(proof.address) }, access);
              proof.consume();
            } else {
              const current = store.user(user.id);
              if (!current?.payout) throw new Error("Save your bank payout details in Settings first");
              if (current.payout.version && current.payout.version !== input.payoutVersion) throw new Error("Your payout details changed. Refresh and review the destination before claiming.");
              fixed.claim(b, user, { acceptedPolicyHash: input.policyHash, expectedRevision: input.expectedRevision }, { kind: "bank", payout: current.payout, payoutVersion: current.payout.version ?? "" }, access);
            }
          });
          store.update(b.id, (fresh) => { fresh.status = "Claimed"; });
          json(res, 202, { bounty: portal.public(store.bounty(b.id), user, true), processing: "assignment" });
          return true;
        } else if (match[2] === "submit") {
          const t = portal.task(b);
          if (!t || b.marketTerms?.kind !== "fixed") throw new Error("Use the pull request form for this bounty");
          await tasks.exclusive(`task:${t.id}`, () => fixed.submit(b, user, { prNumber: input.prNumber, expectedRevision: input.expectedRevision }));
          json(res, 202, { bounty: portal.public(store.bounty(b.id), user, true), processing: "submission" });
          return true;
        } else if (match[2] === "withdraw") {
          const t = portal.task(b);
          if (!t || b.marketTerms?.kind !== "fixed") throw new Error("This bounty has no releasable assignment");
          await tasks.exclusive(`task:${t.id}`, () => fixed.requestWithdraw(b, user, { generation: input.generation, expectedRevision: input.expectedRevision }));
          json(res, 202, { bounty: portal.public(store.bounty(b.id), user, true), processing: "withdrawal" });
          return true;
        } else if (match[2] === "claim") {
          if(b.paymentRail!=="base-usdc") await portal.claim(user,b,input);
          else {
            if(!cryptoReady) throw new Error("USDC test payments unavailable");
            if(b.private && !(await allowedRepo(user,b.repository,true))) throw new Error("Repository access required");
            const t=portal.task(b);if(!t)throw new Error("Bounty not ready");
            const proof=await verifyWalletProof(store,user.id,b.id,t.policyHash,input);
            await tasks.exclusive(`task:${t.id}`,()=>{const current=tasks.store.get(t.id);if(current.policyHash!==input.policyHash)throw new Error("Bounty changed; review it again");proof.consume();tasks.claimCrypto(current,user,proof.address,input.policyHash);});
            b.status="Claimed";store.save(b);
          }
        }
        else if (match[2] === "accept-work") {
          if(user.id!==b.ownerId){json(res,403,{error:"Only the bounty owner can manage this bounty"});return true;}
          throw new Error("Every developer payout requires the agreed checks and creator merge; CI cannot be waived");
        }
        else if (match[2] === "refresh") {
          const t = portal.task(b);
          if (!t) throw new Error("Bounty is still preparing");
          if (user.id !== b.ownerId && user.id !== t.policy.developerId)
            throw new Error("Only a task participant can refresh verification");
          tasks.store.enqueue(t.id);
        } else if (match[2] === "pr") {
          if (b.marketTerms) throw new Error("Deadline bounties use Submit work with the assignment marker");
          const t = portal.task(b);
          if (!t || user.id !== t.policy.developerId)
            throw new Error("Only the assigned developer can submit a PR");
          const number = Number(input.number);
          if (!Number.isSafeInteger(number) || number < 1)
            throw new Error("Enter a valid PR number");
          const pr = await portal
            .userGit(b.ownerId)
            .get<any>(`/repos/${b.repository}/pulls/${number}`);
          if (
            pr.user.id !== user.id ||
            !hasTaskMarker(String(pr.body ?? ""), b.code)
          )
            throw new Error(
              "Use your own PR and include the exact NearPortal-Task identifier in its body",
            );
          await tasks.exclusive(`task:${t.id}`, () =>
            tasks.bindPr(tasks.store.get(t.id), number),
          );
        } else if (match[2] === "simulate-fund") {
          if (tasks.config.mode !== "simulation" || user.id !== b.ownerId)
            throw new Error("Simulated funding is unavailable");
          const t = portal.task(b);
          if (!t) throw new Error("Bounty is still preparing");
          await tasks.exclusive(`task:${t.id}`, () => tasks.fund(tasks.store.get(t.id)));
        } else throw new Error("Unknown bounty action");
        json(res, 200, {
          bounty: portal.public(
            store.bounty(b.id),
            user,
            b.private ? await allowedRepo(user, b.repository) : false,
          ),
        });
        return true;
      }
      const user = auth.require(req, req.method !== "GET");
      if (path === "/treasury" && req.method === "GET") {
        // Status for display only; funding re-verifies the escrow target live before signing.
        const key = `${user.id}:${url.searchParams.get("bounty") ?? ""}`;
        let status = treasuryCache.get(key);
        if (!status) {
          status = await treasury.status(user.id, url.searchParams.get("bounty") ?? undefined);
          treasuryCache.set(key, status, 10_000);
        }
        json(res, 200, status);
        return true;
      }
      if (path === "/judge-payout" && req.method === "POST") {
        if (
          !portal.judge.enabled ||
          tasks.config.mode !== "sandbox" ||
          !process.env.PORTAL_JUDGE_PAYOUT_IBAN
        )
          throw new Error("Demo payout setup is unavailable");
        if (!user.payout)
          portal.savePayout(user, {
            iban: process.env.PORTAL_JUDGE_PAYOUT_IBAN,
            firstName: process.env.PORTAL_JUDGE_PAYOUT_FIRST_NAME,
            lastName: process.env.PORTAL_JUDGE_PAYOUT_LAST_NAME,
            country: process.env.PORTAL_JUDGE_PAYOUT_COUNTRY,
          });
        json(res, 200, { saved: true });
        return true;
      }
      if (path === "/repositories" && req.method === "GET") {
        const page = Number(url.searchParams.get("page") ?? 1);
        if (!Number.isSafeInteger(page) || page < 1 || page > 100)
          throw new Error("Invalid repository page");
        const repos = await repositories(user, page, portal.githubFor(user));
        json(res, 200, {
          repositories: repos,
          nextPage: repos.length === 50 ? page + 1 : null,
        });
        return true;
      }
      if (path === "/workflow-checks" && req.method === "GET") {
        json(res, 200, await workflowChecks(portal.githubFor(user), url.searchParams.get("repository") ?? "", url.searchParams.get("workflow") ?? ""));
        return true;
      }
      if (path === "/verification-files" && req.method === "GET") {
        json(res, 200, await verificationFiles(portal.githubFor(user), url.searchParams.get("repository") ?? "", url.searchParams.get("branch") ?? ""));
        return true;
      }
      if (path === "/repository-setup" && req.method === "GET") {
        const repo = url.searchParams.get("repository") ?? "";
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
          throw new Error("Invalid repository");
        const gh = portal.githubFor(user);
        const data = await gh.get<any>(`/repos/${repo}`);
        const workflows = await gh.get<{
          workflows: { name: string; path: string; id: number }[];
        }>(`/repos/${repo}/actions/workflows?per_page=100`);
        json(res, 200, {
          defaultBranch: data.default_branch,
          squashEnabled: data.allow_squash_merge,
          canWrite: data.permissions?.push,
          workflows: workflows.workflows.map((w) => ({
            id: w.id,
            name: w.name,
            path: w.path,
          })),
        });
        return true;
      }
      if (path === "/bounties" && req.method === "POST") {
        json(res, 201, { bounty: await portal.create(user, await body(req)) });
        return true;
      }
      if (path === "/payout" && req.method === "POST") {
        json(res, 200, { payout: portal.savePayout(user, await body(req)) });
        return true;
      }
      if (path === "/bank" && req.method === "POST") {
        if (!bankPaymentsEnabled()) throw new Error(BANK_DISABLED_MESSAGE);
        const input = await body(req);
        if (
          typeof input.clientId !== "string" ||
          typeof input.clientSecret !== "string" ||
          input.clientId.length > 200 ||
          input.clientSecret.length > 500
        )
          throw new Error(
            "Enter your Monerium sandbox application credentials",
          );
        const currentClientId =
          user.bank?.clientId ??
          (String(user.id) === store.meta("operator")
            ? env.monerium.clientId
            : undefined);
        if (
          input.clientId !== currentClientId &&
          store
            .all()
            .some(
              (b) =>
                b.ownerId === user.id &&
                b.taskId &&
                portal.task(b)?.payment.state !== "Processed",
            )
        )
          throw new Error(
            "Changing bank accounts is locked while a task is active. You may rotate the secret for the same Client ID.",
          );
        const r = await moneriumGate.run(async (signal) => {
          const response = await fetch("https://api.monerium.dev/auth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              client_id: input.clientId as string,
              client_secret: input.clientSecret as string,
            }),
            signal,
          });
          if (response.status === 429 || response.status >= 500) throw new ProviderFailure(`Monerium unavailable (${response.status})`, undefined, response.status);
          return response;
        }, { op: "auth" });
        if (!r.ok)
          throw new Error("Monerium sandbox did not accept these credentials");
        user.bank = {
          clientId: input.clientId,
          clientSecret: input.clientSecret,
        };
        store.saveUser(user);
        json(res, 200, { connected: true });
        return true;
      }
      if (path === "/stats" && req.method === "GET") {
        const mine = store.all().filter((b) => b.ownerId === user.id);
        const submitted = store
          .all()
          .filter((b) => portal.task(b)?.policy.developerId === user.id);
        json(res, 200, {
          published: mine.filter((b) => b.published).length,
          securedCents: mine.reduce((n, b) => {
            const t = portal.task(b);
            return (
              n +
              (t?.funded && t.payment.state !== "Processed" ? b.amountCents : 0)
            );
          }, 0),
          earnedCents: submitted.reduce(
            (n, b) =>
              n +
              (portal.task(b)?.payment.state === "Processed"
                ? b.amountCents
                : 0),
            0,
          ),
        });
        return true;
      }
      json(res, 404, { error: "Portal endpoint not found" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Request failed";
      if (e instanceof ProviderUnavailable || e instanceof ProviderFailure) {
        // A provider outage is reported as such: never as success, never as the user's fault.
        const retry = e instanceof ProviderUnavailable ? Math.max(1, Math.ceil((e.retryAt - Date.now()) / 1000)) : 30;
        res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": String(retry) });
        res.end(JSON.stringify({ error: "An external service is busy or unavailable. Nothing was changed by this failure; retry shortly.", retryAfterSeconds: retry }));
        return true;
      }
      if (e instanceof StaleWriteError || e instanceof StaleBountyError) {
        json(res, 409, { error: message });
        return true;
      }
      json(
        res,
        /Sign in/.test(message)
          ? 401
          : /Only |Cross-origin|Request token|unavailable/.test(message)
            ? 403
            : /not found/.test(message)
              ? 404
              : 400,
        { error: message },
      );
    }
    return true;
  };
  function readiness() {
    let database = true;
    try {
      store.db.prepare("SELECT 1").get();
    } catch {
      database = false;
    }
    const queue = tasks.store.queueStats();
    const maintenance = maintenanceEnabled();
    const workerStalled = !maintenance && Date.now() - tasks.lastTickAt > 30_000;
    const portalStalled = !maintenance && Date.now() - portal.lastCompletedAt > 300_000;
    const providers = allGates().map((g) => g.state());
    return {
      // Ready = this instance can serve requests. Degraded providers or a slow queue are reported
      // but do not take the server out of rotation (they are not fixed by restarting it).
      ready: database && !workerStalled,
      status: !database ? "unavailable" : maintenance ? "maintenance" : workerStalled ? "worker-stalled" : providers.some((p) => p.circuit === "open" || p.pausedUntil) ? "degraded" : "ok",
      maintenance,
      database,
      worker: { paused: maintenance, stalled: workerStalled, inflight: tasks.busy, portalStalled, ...queue },
      providers: providers.map((p) => ({ provider: p.provider, circuit: p.circuit, paused: Boolean(p.pausedUntil) })),
      mode: tasks.config.mode,
      worker_legacy: maintenance ? "paused" : Date.now() - portal.lastCompletedAt < 120_000 ? "running" : "busy",
    };
  }
  metrics.gauge("task_queue_size", () => tasks.store.queueStats().size);
  metrics.gauge("task_queue_due", () => tasks.store.queueStats().due);
  metrics.gauge("task_queue_oldest_due_age_ms", () => tasks.store.queueStats().oldestDueAgeMs);
  metrics.gauge("task_queue_failing", () => tasks.store.queueStats().failing);
  metrics.gauge("worker_inflight", () => tasks.busy);
  metrics.gauge("rate_limiter_keys", () => limiter.size);
  metrics.gauge("payments_needing_attention", () => (tasks.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE json_extract(body,'$.payment.state')='NeedsAttention'").get() as { n: number }).n);
  tasks.onDiscoveryWake = (taskIds) => {
    for (const b of store.byTaskIds(taskIds)) store.meta(`scan:${b.id}`, "0");
  };
  portal.scanEveryMs = 5000;
  portal.discoveryCacheMs = 25_000;
  // Agent (MCP) API: bearer + scopes over the same services; browser flows keep session + CSRF.
  const agent = createAgentApi({
    store, tasks, portal, fixed, reads, limiter, clientIp, auth, allowedRepo,
    deposit: cachedDeposit,
    publishGuard,
    capabilities: bountyModeCapabilities,
    mode: tasks.config.mode,
    usdcReady: () => cryptoReady || tasks.config.mode === "simulation",
  });
  return { store, auth, portal, handler, treasury, readiness, limiter, reads, agent };
}
