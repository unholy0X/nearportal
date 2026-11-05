import { address as evmAddress } from "../crypto/evm.ts";
import { randomUUID, randomBytes } from "node:crypto";
import { marketTerms } from "./market.ts";
import { requireMarketRollout } from "./market-rollout.ts";
import { hash } from "../tasks/domain.ts";
import { bankPaymentsEnabled, BANK_DISABLED_MESSAGE } from "../ops/payment-rails.ts";
import { parsePayout } from "../tasks/payout.ts";
import type { TaskService } from "../tasks/service.ts";
import { git, ghWrite } from "./github.ts";
import { identity, type Bounty, type PortalStore, type User } from "./store.ts";
import {
  judgeConfig,
  hasTaskMarker,
  preparedPrUrl,
  canAutoMerge,
  canApproveJudgeRun,
} from "./judge.ts";

/** Origin users open; hosted deployments must set it (validated at startup), local falls back. */
export function publicOrigin() {
  return process.env.PORTAL_FRONTEND_ORIGIN ?? process.env.APP_ORIGIN ?? "http://127.0.0.1:8787";
}
const discoveryInterval = () => (process.env.GITHUB_WEBHOOK_SECRET ? 300_000 : 30_000);
export const scanStampKey = (bountyId: string) => `scan:${bountyId}`;

export class PortalService {
  /** Fixed-deadline lifecycle (set by the runtime). */
  fixed?: import("../market/fixed.ts").FixedBounties;
  private scannedAt = 0;
  /** Runtime sets these (5 s pass interval, 25 s shared PR-list reuse); tests run every pass live. */
  scanEveryMs = 0;
  discoveryCacheMs = 0;
  readonly judge = judgeConfig();
  private running = false;
  lastCompletedAt = Date.now();
  constructor(
    readonly store: PortalStore,
    readonly tasks: TaskService,
    readonly githubFor = git,
    readonly write = ghWrite,
  ) {}
  userGit(id: number) {
    const user = this.store.user(id);
    if (!user) throw new Error("The repository owner must reconnect GitHub");
    return this.githubFor(user);
  }
  task(b: Bounty) {
    return b.taskId ? this.tasks.store.get(b.taskId) : null;
  }
  canRead(b: Bounty, u?: User) {
    return (
      b.published ||
      b.ownerId === u?.id ||
      Boolean(u && this.task(b)?.policy.developerId === u.id)
    );
  }
  /**
   * List view of a bounty for `u`, from the task already loaded by the read model. The task is
   * reduced to the fields status labels need: list responses stay small and never carry
   * evidence, timelines, payout details or access-request lists.
   */
  summary(b: Bounty, u: User | undefined, verifiedMember: boolean, t: import("../tasks/domain.ts").Task | null) {
    if (!this.canRead(b, u)) throw new Error("Bounty not found");
    const participant = b.ownerId === u?.id || Boolean(u && t?.policy.developerId === u.id);
    const task = t
      ? {
          id: t.id,
          funded: t.funded,
          fundedAt: t.fundedAt,
          disputed: t.disputed,
          prNumber: t.prNumber,
          jobId: t.jobId,
          openBounty: t.openBounty,
          policyHash: t.policyHash,
          payment: { state: t.payment.state, reference: null, error: null },
          verdict: t.verdict ? { status: t.verdict.status, reasons: t.verdict.reasons } : null,
          evidence: t.evidence && (!b.private || participant || verifiedMember) ? { merged: t.evidence.merged } : null,
          policy: { developerId: t.policy.developerId, developerLogin: t.policy.developerLogin, repository: t.policy.repository, branch: t.policy.branch, currency: t.policy.currency, ...(t.policy.paymentRail ? { paymentRail: t.policy.paymentRail } : {}) },
        }
      : null;
    return {
      ...b,
      revision: hash(b),
      status: this.publicState(b, t),
      task,
      summary: true as const,
      market: this.fixed?.view(b, u?.id) ?? null,
      repositoryAccess: !b.private || participant || verifiedMember,
      client: { id: b.ownerId, login: b.owner },
      role: b.ownerId === u?.id ? "client" : t?.policy.developerId === u?.id ? "developer" : "visitor",
      canClaim: Boolean(t?.funded && !t.policy.developerId && !t.disputed && u && u.id !== b.ownerId && (!b.private || verifiedMember)),
      error: participant ? b.error : null,
    };
  }
  public(b: Bounty, u?: User, verifiedMember = false) {
    if (!this.canRead(b, u)) throw new Error("Bounty not found");
    const t = this.task(b);
    const participant =
      b.ownerId === u?.id || Boolean(u && t?.policy.developerId === u.id);
    const task = t ? this.tasks.public(t) : null;
    if (task && !participant) {
      task.policy = { ...task.policy, recipient: "Private payout destination" };
      if (task.fundingPolicy)
        task.fundingPolicy = {
          ...task.fundingPolicy,
          recipient: "Private payout destination",
        };
      task.payment = { ...task.payment, error: null };
      delete task.overpayment;
      if (b.private && !verifiedMember) task.evidence = null;
    }
    const state = this.publicState(b, t);
    return {
      ...b,
      preparedPrUrl:
        this.judge.enabled &&
        this.judge.repository === b.repository &&
        !b.private &&
        b.published &&
        this.judge.tasks[b.id]
          ? preparedPrUrl(
              b.repository,
              b.branch,
              this.judge.tasks[b.id]!,
              b.code,
              b.title,
            )
          : null,
      judgeAutoMerge:
        this.judge.autoMerge &&
        this.judge.repository === b.repository &&
        !b.private &&
        Boolean(this.judge.tasks[b.id]),
      revision: hash(b),
      status: state,
      task,
      market: this.fixed?.view(b, u?.id) ?? null,
      repositoryAccess: !b.private || participant || verifiedMember,
      accessRequest: u
        ? (this.store.accessRequests(b.id).find((r) => r.userId === u.id) ??
          null)
        : null,
      accessRequests:
        b.ownerId === u?.id ? this.store.accessRequests(b.id) : [],
      client: { id: b.ownerId, login: b.owner },
      role:
        b.ownerId === u?.id
          ? "client"
          : t?.policy.developerId === u?.id
            ? "developer"
            : "visitor",
      canClaim: Boolean(
        t?.funded &&
          !t.policy.developerId &&
          !t.disputed &&
          u &&
          u.id !== b.ownerId &&
          (!b.private || verifiedMember),
      ),
      error:
        b.ownerId === u?.id || t?.policy.developerId === u?.id ? b.error : null,
    };
  }
  private publicState(b: Bounty, t: import("../tasks/domain.ts").Task | null) {
    return t?.disputed
      ? "Blocked"
      : t?.payment.state === "Processed"
        ? "Paid"
        : t?.payment.state !== "NotRequested" && t
          ? "Releasing"
          : t?.verdict?.status === "blocked"
            ? "Blocked"
            : t?.prNumber
              ? "InReview"
              : t?.policy.developerId
                ? "Claimed"
                : t?.funded
                  ? "Open"
                  : b.status;
  }
  /** `options.id` lets a resumable caller (agent batches) fix the ID before the side effect. */
  async create(u: User, input: Record<string, unknown>, existing?: Bounty, options: { id?: string; github?: ReturnType<typeof git> } = {}) {
    if (
      existing &&
      (existing.ownerId !== u.id ||
        existing.status !== "Draft" ||
        existing.taskId)
    )
      throw new Error("Only the client can edit an unpublished draft");
    const text = (key: string, max = 4000, fallback = "") => {
      const v = input[key] ?? fallback;
      if (typeof v !== "string" || !v.trim() || v.length > max)
        throw new Error(`Enter a valid ${key}`);
      return v.trim();
    };
    const repository = text("repository", 200);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
      throw new Error("Choose a GitHub repository");
    const repo = await (options.github ?? this.githubFor(u)).get<any>(`/repos/${repository}`);
    if (!repo.permissions?.push)
      throw new Error("Repository write access is required");
    if (repo.archived)
      throw new Error("Use an active repository");
    if (existing) {
      const current = this.store.bounty(existing.id);
      if (
        current.status !== "Draft" ||
        current.taskId ||
        current.ownerId !== u.id
      )
        throw new Error(
          "This draft was published while you were editing. Its accepted terms cannot be changed.",
        );
    }
    if (input.paymentRail !== undefined && input.paymentRail !== "bank" && input.paymentRail !== "base-usdc") throw new Error("Choose bank or Base Sepolia USDC payment");
    const rail = input.paymentRail ?? existing?.paymentRail;
    if (rail !== "base-usdc" && !bankPaymentsEnabled()) throw new Error(BANK_DISABLED_MESSAGE);
    const refundAddress = rail === "base-usdc" ? evmAddress(input.refundAddress ?? existing?.refundAddress) : undefined;
    const amount = Number(input.amountCents);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100_000)
      throw new Error("Sandbox rewards must be €0.01–€1,000");
    const versionedTerms = input.marketTerms !== undefined
      ? marketTerms(input.marketTerms, amount)
      : existing?.marketTerms ? marketTerms(existing.marketTerms, amount) : undefined;
    const criteria = text("criteria")
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
    if (criteria.length > 20) throw new Error("Use at most 20 criteria");
    const now = new Date().toISOString();
    const b: Bounty = {
      id: existing?.id ?? options.id ?? randomUUID(),
      code:
        existing?.code ?? `NP-${randomBytes(5).toString("hex").toUpperCase()}`,
      ownerId: u.id,
      owner: u.login,
      repository: repo.full_name,
      private: repo.private,
      title: text("title", 160),
      description: text("description", 12000),
      criteria,
      amountCents: amount,
      ...(rail === "base-usdc" ? {paymentRail:"base-usdc" as const, refundAddress} : {}),
      ...(versionedTerms ? { marketTerms: versionedTerms } : {}),
      branch: text("branch", 200, repo.default_branch),
      checkName: text("checkName", 200, "acceptance"),
      checkAppId: Number(input.checkAppId ?? 15368),
      workflowPath: text(
        "workflowPath",
        300,
        ".github/workflows/acceptance.yml",
      ),
      protectedPaths: text("protectedPaths", 4000, "package.json"),
      taskId: null,
      issueNumber: null,
      issueUrl: null,
      status: "Draft",
      published: false,
      error: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (!Number.isSafeInteger(b.checkAppId) || b.checkAppId < 1)
      throw new Error("Enter a valid GitHub check App ID");
    this.store.save(b);
    return this.public(b, u);
  }
  publish(u: User, b: Bounty, revision: unknown = hash(b)) {
    const current = this.store.bounty(b.id);
    if (revision !== hash(current))
      throw new Error(
        "This draft changed. Refresh and review the current agreement before publishing.",
      );
    Object.assign(b, current);
    if (b.ownerId !== u.id)
      throw new Error("Only the client can publish this bounty");
    if (b.taskId || b.status !== "Draft")
      throw new Error("This bounty has already been submitted");
    if (b.marketTerms) requireMarketRollout(b.marketTerms.kind, b.paymentRail === "base-usdc" ? "base-usdc" : "bank");
    b.status = "Preparing";
    b.error = null;
    this.store.save(b);
    this.store.enqueue(b, "prepare");
  }
  async claim(u: User, b: Bounty, body: Record<string, unknown>) {
    if (!u.payout)
      throw new Error("Save your payout details in Settings first");
    const t = this.task(b);
    if (!t) throw new Error("This bounty is not ready");
    // Private repository membership is checked using the authenticated developer's token.
    if (b.private) await this.githubFor(u).get(`/repos/${b.repository}`);
    await this.tasks.exclusive(`task:${t.id}`, () => {
      const current = this.store.user(u.id);
      if (
        !current?.payout ||
        (current.payout.version &&
          current.payout.version !== body.payoutVersion)
      )
        throw new Error(
          "Your payout details changed. Refresh and review the destination before claiming.",
        );
      this.tasks.claim(
        this.tasks.store.get(t.id),
        u,
        current.payout,
        body.policyHash,
      );
    });
    this.store.update(b.id, (fresh) => {
      fresh.status = "Claimed";
    });
  }
  savePayout(u: User, body: Record<string, unknown>) {
    const p = parsePayout(
      body,
      this.tasks.config.mode === "sandbox"
        ? this.tasks.config.sandboxPayoutIbans
        : [],
    );
    u.payout = {
      firstName: p.firstName,
      lastName: p.lastName,
      iban: p.iban,
      country: p.country,
      version: randomBytes(16).toString("hex"),
    };
    this.store.saveUser(u);
    return {
      name: `${p.firstName} ${p.lastName}`,
      iban: `${p.iban.slice(0, 4)}…${p.iban.slice(-4)}`,
      country: p.country,
      version: u.payout.version,
    };
  }
  issueBody(b: Bounty) {
    return `${b.description}\n\n## Acceptance criteria\n${b.criteria.map((c) => `- [ ] ${c}`).join("\n")}\n\n## NearPortal funded bounty\nReward: ${b.paymentRail === "base-usdc" ? "USDC on Base Sepolia" : "EUR"} ${(b.amountCents / 100).toFixed(2)} (${this.tasks.config.mode === "sandbox" ? "sandbox / test funds" : "simulation"}).\n\nClaim and verify escrow: ${publicOrigin()}/bounties/${b.id}\n\nInclude this exact line in your pull request body:\n\n\`NearPortal-Task: ${b.code}\`\n\nRequired check: \`${b.checkName}\` from the agreed workflow. Payment follows a qualifying **merge by @${b.owner}**, after successful checks. Claim this bounty in NearPortal before submitting.\n`;
  }
  /** True when b.error was written by PR discovery and may be cleared by a later successful search.
   * Errors recorded before ownership tracking carry no marker; at this point discovery is the only
   * writer left for them unless a background job for the bounty is still pending (jobs own their errors,
   * and the prepared-merge path only runs once a PR is bound). */
  private ownsDiscoveryError(b: Bounty) {
    if (!b.error) return false;
    const owned = this.store.meta(`scan-error:${b.id}`);
    if (owned) return owned === b.error;
    return owned === undefined && !this.store.hasJob(b.id);
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const job of this.store.jobs()) {
        const b = this.store.bounty(job.bounty_id);
        const u = this.store.user(b.ownerId);
        try {
          if (!u) throw new Error("Reconnect the owner's GitHub account");
          if (job.kind === "prepare") {
            if (!b.taskId) {
              const existing = this.tasks.store
                .all()
                .find((t) => t.portalId === b.id);
              if (existing) {
                b.taskId = existing.id;
                b.status = "AwaitingFunding";
                this.store.save(b);
              }
            }
            if (!b.taskId) {
              const result = await this.tasks.exclusive(`create:${b.id}`, () =>
                this.tasks.create(
                  {
                    title: b.title,
                    description: b.description,
                    criteria: b.criteria.join("\n"),
                    amountCents: b.amountCents,
                    ...(b.paymentRail ? {paymentRail:b.paymentRail, refundAddress:b.refundAddress} : {}),
                    repository: b.repository,
                    branch: b.branch,
                    maintainer: u.login,
                    workflowPath: b.workflowPath,
                    protectedPaths: b.protectedPaths,
                    checkName: b.checkName,
                    checkAppId: b.checkAppId,
                  },
                  {
                    openBounty: true,
                    github: this.githubFor(u),
                    ownerId: u.id,
                    portalId: b.id,
                    portalCode: b.code,
                    ...(b.marketTerms?.kind === "fixed" ? { market: { kind: "fixed" as const, deliveryHours: b.marketTerms.deliveryHours } } : {}),
                  },
                ),
              );
              b.taskId = result.task.id;
              b.status = "AwaitingFunding";
              this.store.save(b);
            }
            // The versioned agreement (fixed price + deadline) is created from the funding hash.
            if (b.marketTerms?.kind === "fixed") {
              if (!this.fixed) throw new Error("Deadline bounties are not available on this deployment");
              this.fixed.ensureMarket(b, this.tasks.store.get(b.taskId!));
            }
            // Publish action is the client's explicit acceptance of the open funding mandate.
            await this.tasks.exclusive(`task:${b.taskId}`, () => {
              const t = this.tasks.store.get(b.taskId!);
              this.tasks.accept(t, "client", t.policyHash);
            });
          }
          if (job.kind === "issue" && !b.issueNumber) {
            // Reconcile by exact code before retrying an uncertain GitHub issue creation.
            const issues = await this.githubFor(u).get<any[]>(
              `/repos/${b.repository}/issues?state=all&creator=${encodeURIComponent(u.login)}&per_page=100`,
            );
            const found = issues.filter(
              (i) =>
                !i.pull_request &&
                String(i.body ?? "").includes(`NearPortal-Task: ${b.code}`),
            );
            if (found.length > 1)
              throw new Error(
                "Multiple issues have this bounty identifier; manual review required",
              );
            let issue = found[0];
            if (!issue) {
              if (this.store.meta(`issue-attempt:${b.id}`))
                throw new Error(
                  "Issue publication outcome uncertain. Reconciliation has not found its identifier; manual review required before retrying creation.",
                );
              this.store.meta(`issue-attempt:${b.id}`, "1");
              issue = await this.write<any>(
                u,
                `/repos/${b.repository}/issues`,
                "POST",
                { title: `[${b.code}] ${b.title}`, body: this.issueBody(b) },
              );
            }
            b.issueNumber = issue.number;
            b.issueUrl = issue.html_url;
            b.published = true;
            this.store.save(b);
          }
          b.error = null;
          this.store.save(b);
          this.store.done(job.id);
        } catch (e) {
          const message = e instanceof Error ? e.message : "Background job failed";
          this.store.update(b.id, (fresh) => {
            fresh.error = message;
            if (job.attempts >= 5) fresh.status = "NeedsAttention";
          });
          this.store.retry(job.id, message, job.attempts);
        }
      }
      // The per-bounty pass is cheap but not free at 1,000+ records: run it every few seconds,
      // over a batched read, instead of on every 2-second job tick.
      if (Date.now() - this.scannedAt < this.scanEveryMs) return;
      this.scannedAt = Date.now();
      const bounties = this.store.all().filter((b) => b.taskId && b.status !== "Paid");
      const taskMap = this.tasks.store.many(bounties.map((b) => b.taskId!));
      for (const b of bounties) {
        const t = taskMap.get(b.taskId!);
        if (!t) continue;
        if (
          t.prNumber &&
          this.judge.autoMerge &&
          this.judge.tasks[b.id] &&
          !b.private &&
          t.payment.state === "NotRequested"
        ) {
          const key = `judge-merge:${b.id}`;
          if (Date.now() - Number(this.store.meta(key) ?? 0) >= 30_000) {
            this.store.meta(key, String(Date.now()));
            try {
              const github = this.userGit(b.ownerId);
              const pr = await github.get<any>(
                `/repos/${b.repository}/pulls/${t.prNumber}`,
              );
              if (
                pr.head?.repo?.id !== t.policy.repositoryId &&
                pr.head?.repo?.full_name
              )
                pr.head.repo = await github.get<any>(
                  `/repos/${pr.head.repo.full_name}`,
                );
              const evidence = await github.evidence(t);
              for (const run of evidence.runs) {
                if (
                  canApproveJudgeRun(
                    this.judge,
                    t,
                    pr,
                    run,
                    b.ownerId,
                    b.private,
                  )
                )
                  await this.write(
                    this.store.user(b.ownerId)!,
                    `/repos/${b.repository}/actions/runs/${run.id}/approve`,
                    "POST",
                    {},
                  );
              }
              if (
                canAutoMerge(this.judge, t, pr, evidence, b.ownerId, b.private)
              ) {
                const result = await this.write<{ merged: boolean }>(
                  this.store.user(b.ownerId)!,
                  `/repos/${b.repository}/pulls/${t.prNumber}/merge`,
                  "PUT",
                  {
                    sha: this.judge.tasks[b.id]!.headSha,
                    merge_method: "squash",
                  },
                );
                if (!result.merged)
                  throw new Error(
                    "GitHub has not confirmed the prepared demo merge",
                  );
                await this.tasks.exclusive(`task:${t.id}`, () =>
                  this.tasks.store.enqueue(t.id),
                );
              }
            } catch (error) {
              this.store.update(b.id, (fresh) => {
                fresh.error =
                  error instanceof Error
                    ? error.message
                    : "Prepared demo merge is waiting";
              });
            }
          }
        }
        if (t.funded && !b.published && b.status !== "Draft") {
          this.store.update(b.id, (fresh) => {
            fresh.status = "Open";
          });
          this.store.enqueue(b, "issue");
        }
        if (
          !t.funded ||
          !t.policy.developerId ||
          t.prNumber ||
          t.payment.state !== "NotRequested" ||
          t.disputed ||
          // Deadline bounties never auto-bind a PR: the developer submits an exact commit.
          t.policy.market
        )
          continue;
        const stamp = Number(this.store.meta(`scan:${b.id}`) ?? 0);
        if (Date.now() - stamp < discoveryInterval()) continue;
        this.store.meta(`scan:${b.id}`, String(Date.now()));
        try {
          // Bounties on one repository share one list request (same credential + path), revalidated
          // by ETag; this is discovery metadata only, payment evidence is always re-read.
          const prs = await this.userGit(b.ownerId).get<any[]>(
            `/repos/${b.repository}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
            { maxAgeMs: this.discoveryCacheMs },
          );
          const matches = prs.filter(
            (p) =>
              p.user.id === t.policy.developerId &&
              p.base.ref === b.branch &&
              hasTaskMarker(String(p.body ?? ""), b.code) &&
              Date.parse(p.created_at) >= Date.parse(t.fundedAt ?? t.createdAt),
          );
          if (matches.length > 1)
            throw new Error(
              "Multiple PRs use this task identifier. Keep the identifier on one submission only.",
            );
          if (matches.length === 1) {
            await this.tasks.exclusive(`task:${t.id}`, () =>
              this.tasks.bindPr(this.tasks.store.get(t.id), matches[0].number),
            );
          }
          // The search succeeded (with zero or one match): a discovery error is now stale.
          this.store.update(b.id, (fresh) => {
            if (matches.length === 1) fresh.status = "InReview";
            if (this.ownsDiscoveryError(fresh)) fresh.error = null;
          });
          this.store.meta(`scan-error:${b.id}`, "");
        } catch (e) {
          const message = e instanceof Error ? e.message : "PR discovery failed";
          this.store.update(b.id, (fresh) => {
            fresh.error = message;
          });
          this.store.meta(`scan-error:${b.id}`, message);
        }
      }
    } finally {
      this.running = false;
      this.lastCompletedAt = Date.now();
    }
  }
}
