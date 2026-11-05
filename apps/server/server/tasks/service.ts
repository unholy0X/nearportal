import { address as evmAddress } from "../crypto/evm.ts";
import { evaluateRelease } from "./release-policy.ts";
import { evaluateMergePolicy } from "./merge-policy.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { evaluate, hash, note, type Task, type TaskPolicy } from "./domain.ts";
import { fixtureEvidence, GitHub } from "./github.ts";
import type { PaymentAdapter } from "./payments.ts";
import { PaymentPending } from "./payment-pending.ts";
import {
  parsePayout,
  payoutCommitment,
  payoutFor,
  verifyTaskPayout,
  payoutLabel,
  shortIban,
  bankRefundCommitment,
} from "./payout.ts";
import { StaleWriteError, TaskStore } from "./store.ts";
import { KeyedLock } from "../ops/locks.ts";
import { ProviderUnavailable, backoff } from "../ops/provider.ts";
import { metrics } from "../ops/metrics.ts";
import { log } from "../ops/log.ts";
import { bankPaymentsEnabled, BANK_DISABLED_MESSAGE } from "../ops/payment-rails.ts";

const intEnv = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isSafeInteger(v) && v > 0 ? v : fallback;
};

export interface TaskConfig {
  mode: "simulation" | "sandbox";
  githubMode: "fixture" | "live";
  verifier: string;
  cryptoVerifier?: string;
  recipient: string;
  refundShortIban?: string;
  sandboxPayoutIbans?: readonly string[];
}

export class TaskService {
  /** Per-task (and per shared resource) locks; there is no global lock any more. */
  readonly locks = new KeyedLock();
  private inflight = new Set<string>();
  readonly concurrency = intEnv("WORKER_CONCURRENCY", 4);
  lastTickAt = Date.now();
  /** Fixed-deadline lifecycle (common to both rails), installed by the portal runtime. */
  lifecycle?: {
    owns(t: Task): boolean;
    /** Reconcile funding, assignment binding, submission relay, withdrawal and expiry. */
    step(t: Task): Promise<void>;
    /** Extra release conditions (exact timely head, relayed submission). Mutates the verdict. */
    gate(t: Task, evidence: import("./domain.ts").PrEvidence, verdict: import("./domain.ts").Verdict): void;
    /** Commit the market authorization and the unique release record together, before any payment call. */
    authorize(t: Task, evidenceHash: string): void;
    /** Called after the rail confirmed the payment. */
    settled(t: Task): void;
    /** Earliest time this task must be re-checked (deadline + relay grace). */
    nextCheck(t: Task): number | null;
  };
  /** Set by the portal: a pull_request webhook asks PR discovery to run for these tasks now. */
  onDiscoveryWake?: (taskIds: string[]) => void;
  constructor(
    readonly store: TaskStore,
    readonly github: GitHub,
    readonly payments: PaymentAdapter,
    readonly config: TaskConfig,
  ) {
    if (config.mode === "sandbox" && config.githubMode !== "live")
      throw new Error("Sandbox payments require live GitHub verification.");
  }
  /**
   * Serializes work on one key (normally `task:<id>`), so HTTP mutations and the worker never
   * interleave on the same task, while independent tasks proceed in parallel. Writes are also
   * compare-and-swap protected in the store.
   */
  exclusive<T>(key: string, run: () => Promise<T> | T): Promise<T> {
    return this.locks.run(key, run);
  }
  get busy() {
    return this.inflight.size;
  }
  /** Normal polling interval while a task waits for an external event. */
  private waitFor(t: Task) {
    if (t.mode === "simulation") return intEnv("WORKER_SIMULATION_POLL_MS", 2000);
    // A payment in flight is followed closely; everything else waits for an event (deposit,
    // claim, PR, webhook) and is only re-checked as a bounded safety net.
    if (["Signing", "Signed", "Submitted", "Authorized"].includes(t.payment.state)) return intEnv("WORKER_PAYMENT_POLL_MS", 20_000);
    if (!t.funded) return intEnv("WORKER_FUNDING_POLL_MS", 60_000);
    if (t.openBounty && !t.policy.developerId) return intEnv("WORKER_IDLE_POLL_MS", 900_000); // claims enqueue the task
    if (!t.prNumber) return intEnv("WORKER_CLAIMED_POLL_MS", 300_000); // PR discovery binds and enqueues
    return process.env.GITHUB_WEBHOOK_SECRET ? intEnv("WORKER_GITHUB_RECONCILE_MS", 600_000) : intEnv("WORKER_GITHUB_POLL_MS", 120_000);
  }
  /** Runtime only: refill a worker slot as soon as one frees up instead of waiting for the next tick. */
  continuous = false;
  async create(
    input: Record<string, unknown>,
    options: {
      openBounty?: boolean;
      github?: GitHub;
      ownerId?: number;
      portalId?: string;
      portalCode?: string;
      bankRefund?: Record<string, unknown>;
      market?: { kind: "fixed"; deliveryHours: number };
    } = {},
  ) {
    if (input.paymentRail !== "base-usdc" && !bankPaymentsEnabled()) throw new Error(BANK_DISABLED_MESSAGE);
    const bankRefund = input.paymentRail !== "base-usdc" && options.bankRefund
      ? parsePayout(options.bankRefund, this.config.mode === "sandbox" ? this.config.sandboxPayoutIbans : [], this.config.mode === "sandbox") : undefined;
    if (this.config.mode === "sandbox" && options.ownerId && input.paymentRail !== "base-usdc" && !bankRefund)
      throw new Error("Save the creator's refund bank details in Settings before publishing");
    if (input.marketTerms !== undefined && !options.market)
      throw new Error("Versioned bounty terms require the market payment adapter; they cannot use a legacy task mandate");
    if (options.market && (!options.openBounty || options.market.kind !== "fixed"))
      throw new Error("Only fixed-price open bounties support delivery deadlines in this version");
    const text = (name: string, fallback = "") => {
      const value = input[name] ?? fallback;
      if (typeof value !== "string" || !value.trim() || value.length > 4000)
        throw new Error(`Invalid ${name}`);
      return value.trim();
    };
    const title = text("title");
    if (
      input.description !== undefined &&
      (typeof input.description !== "string" ||
        !input.description.trim() ||
        input.description.length > 12000)
    )
      throw new Error("Invalid description");
    if (options.portalCode && !/^NP-[A-F0-9]{10}$/.test(options.portalCode))
      throw new Error("Invalid submission identifier");
    const criteria = text("criteria")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (criteria.length > 20)
      throw new Error("Use at most 20 acceptance criteria");
    const amountCents = input.amountCents;
    if (
      !Number.isSafeInteger(amountCents) ||
      (amountCents as number) <= 0 ||
      (amountCents as number) > 100_000
    )
      throw new Error("Demo tasks must be between €0.01 and €1,000.");
    const repository = text("repository", "nearportal-demo/csv-export");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
      throw new Error("Repository must be owner/name");
    const branch = text("branch", "main");
    const workflowPath = text(
      "workflowPath",
      ".github/workflows/acceptance.yml",
    );
    const protectedPaths = text(
      "protectedPaths",
      "test/acceptance.test.mjs\npackage.json",
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const path of [workflowPath, ...protectedPaths])
      if (path.startsWith("/") || path.split("/").some((p) => p === ".." || !p))
        throw new Error("Use repository-relative protected file paths");
    if (
      !workflowPath.startsWith(".github/workflows/") ||
      !/\.ya?ml$/.test(workflowPath)
    )
      throw new Error("Choose a .github/workflows YAML file");
    const checkName = text("checkName", "acceptance");
    const checkAppId = input.checkAppId ?? 15368;
    if (!Number.isSafeInteger(checkAppId) || Number(checkAppId) <= 0)
      throw new Error("Invalid check source App ID");
    const githubPolicy =
      this.config.githubMode === "live"
        ? await (options.github ?? this.github).policy({
            repository,
            branch,
            developer: options.openBounty ? "Unclaimed" : text("developer"),
            open: options.openBounty,
            maintainer: text("maintainer"),
            workflowPath,
            protectedPaths,
            checkName,
            checkAppId: Number(checkAppId),
          })
        : {
            repositoryId: 100,
            baselineSha: "0".repeat(40),
            developerId: 200,
            developerLogin: "demo-developer",
            mergerIds: [300],
            checks: [{ name: checkName, appId: Number(checkAppId) }],
            protectedFiles: [...new Set([workflowPath, ...protectedPaths])].map(
              (path) => ({ path, blobSha: "1".repeat(40) }),
            ),
          };
    const policy: TaskPolicy = {
      version: 1,
      title,
      ...(input.description
        ? { description: String(input.description).trim() }
        : {}),
      ...(options.portalCode ? { submissionCode: options.portalCode } : {}),
      criteria,
      amountCents: amountCents as number,
      currency: input.paymentRail === "base-usdc" ? "USD" : "EUR",
      ...(input.paymentRail === "base-usdc" ? {paymentRail:"base-usdc" as const, refundAddress: evmAddress(input.refundAddress)} : {}),
      ...(bankRefund ? { bankRefundCommitment: bankRefundCommitment(options.ownerId!, bankRefund), bankRefundRecipient: shortIban(bankRefund.iban) } : {}),
      repository,
      branch,
      workflowPath,
      ...githubPolicy,
      ...(options.openBounty
        ? { developerId: 0, developerLogin: "Unclaimed" }
        : {}),
      mergeMethod: "any",
      verifier: input.paymentRail === "base-usdc" ? (this.config.cryptoVerifier ?? this.config.verifier) : this.config.verifier,
      recipient: options.openBounty
        ? "Assigned after a funded developer claim"
        : "Awaiting developer payout details",
      ...(options.openBounty
        ? { assignmentRule: "first-eligible-github-claim" as const }
        : {}),
      ...(options.market ? { market: { version: 1 as const, kind: "fixed" as const, deliveryHours: options.market.deliveryHours } } : {}),
    };
    const clientToken = randomBytes(32).toString("hex");
    const developerToken = randomBytes(32).toString("hex");
    const task: Task = {
      id: randomUUID(),
      ...(options.ownerId ? { ownerId: options.ownerId } : {}),
      ...(bankRefund ? { bankRefund } : {}),
      ...(options.portalId ? { portalId: options.portalId } : {}),
      ...(options.openBounty
        ? {
            openBounty: true,
            fundingPolicy: structuredClone(policy),
            fundingPolicyHash: hash(policy),
          }
        : {}),
      mode: this.config.mode,
      githubMode: this.config.githubMode,
      policy,
      policyHash: hash(policy),
      clientTokenHash: hash(clientToken),
      developerTokenHash: hash(developerToken),
      clientAccepted: false,
      developerAccepted: false,
      funded: false,
      fundedAt: null,
      disputed: false,
      prNumber: null,
      jobId: null,
      verdict: null,
      evidence: null,
      payment: { state: "NotRequested", reference: null, error: null },
      fixture: "open",
      timeline: [],
      createdAt: new Date().toISOString(),
    };
    note(
      task,
      "Task created. Both parties must accept the fixed criteria and automatic payment mandate.",
    );
    this.store.save(task);
    return { task: this.public(task), clientToken, developerToken };
  }
  public(t: Task) {
    const {
      clientTokenHash: _c,
      developerTokenHash: _d,
      payout: _p,
      bankProfileKey: _bank,
      bankRefund: _refund,
      ...safe
    } = t;
    if (t.policy.paymentRail === "base-usdc") safe.timeline = safe.timeline.map(event => event.message === "Monerium deposit confirmed in escrow." ? { ...event, message: "USDC deposit confirmed on Base Sepolia and recorded in NEAR escrow." } : event);
    return safe;
  }
  authorize(
    id: string,
    token: string,
  ): { task: Task; role: "client" | "developer" } {
    const task = this.store.get(id);
    const digest = hash(token);
    if (token && digest === task.clientTokenHash)
      return { task, role: "client" };
    if (token && digest === task.developerTokenHash)
      return { task, role: "developer" };
    throw new Error("A valid task access link is required");
  }
  setPayout(
    t: Task,
    role: "client" | "developer",
    input: Record<string, unknown>,
  ) {
    if (role !== "developer")
      throw new Error("Only the developer can set the payout destination");
    if (
      t.clientAccepted ||
      t.developerAccepted ||
      t.jobId !== null ||
      t.funded ||
      t.payment.state !== "NotRequested"
    )
      throw new Error(
        "Payout details are locked after either party accepts. Create a new task to change them.",
      );
    const payout = parsePayout(
      input,
      this.config.mode === "sandbox" ? this.config.sandboxPayoutIbans : [],
      this.config.mode === "sandbox",
    );
    if (shortIban(payout.iban) === (t.policy.bankRefundRecipient ?? this.config.refundShortIban))
      throw new Error(
        "Use a payout IBAN distinct from the client's refund account",
      );
    t.payout = payout;
    t.policy.recipient = payoutLabel(payout);
    t.policy.payoutCommitment = payoutCommitment(t.policy.developerId, payout);
    t.policyHash = hash(t.policy);
    note(
      t,
      "Developer saved payout details. Both parties must accept the updated policy.",
    );
    this.store.save(t);
  }
  claimCrypto(t: Task, developer: {id:number;login:string}, recipient:string, policyHash:unknown) {
    if(t.policy.paymentRail!=="base-usdc" || !t.openBounty || !t.funded || !t.clientAccepted || t.disputed || t.policy.developerId!==0) throw new Error("This crypto bounty is not available to claim");
    if(t.ownerId===developer.id || t.policy.mergerIds.includes(developer.id)) throw new Error("The client cannot claim their own bounty");
    if(policyHash!==t.policyHash || !/^0x[0-9a-f]{40}$/.test(recipient) || /^0x0{40}$/.test(recipient) || recipient===t.crypto?.address || recipient===t.policy.refundAddress) throw new Error("Review the current crypto payout agreement");
    validateFundingPolicy(t);
    t.policy.developerId=developer.id; t.policy.developerLogin=developer.login;
    t.policy.recipient=recipient;t.policy.payoutCommitment=hash({developerId:developer.id,rail:"base-usdc",address:recipient});t.policyHash=hash(t.policy);t.developerAccepted=true;
    note(t,`${developer.login} claimed the USDC bounty and authorized the wallet destination.`);
    this.store.transaction(()=>{this.store.save(t);this.store.enqueue(t.id);});
  }
  claim(
    t: Task,
    developer: { id: number; login: string },
    input: Record<string, unknown>,
    policyHash: unknown,
  ) {
    if (t.policy.paymentRail === "base-usdc") throw new Error("Use the signed wallet claim flow");
    if (
      !t.openBounty ||
      !t.funded ||
      !t.clientAccepted ||
      t.disputed ||
      t.policy.developerId !== 0
    )
      throw new Error("This funded bounty is not available to claim");
    if (t.ownerId === developer.id || t.policy.mergerIds.includes(developer.id))
      throw new Error("The client cannot claim their own bounty");
    if (policyHash !== t.policyHash)
      throw new Error("Review the current bounty policy before claiming");
    validateFundingPolicy(t);
    const payout = parsePayout(
      input,
      this.config.mode === "sandbox" ? this.config.sandboxPayoutIbans : [],
      this.config.mode === "sandbox",
    );
    if (shortIban(payout.iban) === (t.policy.bankRefundRecipient ?? this.config.refundShortIban))
      throw new Error(
        "Use a payout IBAN distinct from the client's refund account",
      );
    t.policy.developerId = developer.id;
    t.policy.developerLogin = developer.login;
    t.payout = payout;
    t.policy.recipient = payoutLabel(payout);
    t.policy.payoutCommitment = payoutCommitment(developer.id, payout);
    t.policyHash = hash(t.policy);
    t.developerAccepted = true;
    note(
      t,
      `${developer.login} claimed the funded bounty and accepted the criteria and payout destination.`,
    );
    this.store.transaction(() => {
      this.store.save(t);
      this.store.enqueue(t.id);
    });
  }
  /**
   * Fixed-deadline mode: bind the exclusive assignment to the task policy. Called inside the market
   * store transaction (no own transaction), so market and task commit together. The destination is
   * the one the developer accepted for this rail; it is committed in the assignment policy hash.
   */
  assign(t: Task, developer: { id: number; login: string }, destination: { kind: "bank"; payout: Record<string, string> } | { kind: "usdc"; address: string }, assignment: { generation: number; marker: string }) {
    if (!t.policy.market || !t.openBounty || !t.funded || !t.clientAccepted || t.disputed || t.policy.developerId !== 0)
      throw new Error("This funded bounty is not available to claim");
    if (t.ownerId === developer.id || t.policy.mergerIds.includes(developer.id)) throw new Error("The client cannot claim their own bounty");
    validateFundingPolicy(t);
    if (destination.kind === "bank") {
      if (t.policy.paymentRail === "base-usdc") throw new Error("This bounty pays in USDC: connect a wallet destination");
      const payout = parsePayout(destination.payout, this.config.mode === "sandbox" ? this.config.sandboxPayoutIbans : [], this.config.mode === "sandbox");
      if (shortIban(payout.iban) === (t.policy.bankRefundRecipient ?? this.config.refundShortIban)) throw new Error("Use a payout IBAN distinct from the client's refund account");
      t.payout = payout;
      t.policy.recipient = payoutLabel(payout);
      t.policy.payoutCommitment = payoutCommitment(developer.id, payout);
    } else {
      if (t.policy.paymentRail !== "base-usdc") throw new Error("This bounty pays by bank transfer: save bank payout details");
      if (!/^0x[0-9a-f]{40}$/.test(destination.address) || /^0x0{40}$/.test(destination.address) || destination.address === t.crypto?.address || destination.address === t.policy.refundAddress) throw new Error("Review the USDC payout address");
      t.policy.recipient = destination.address;
      t.policy.payoutCommitment = hash({ developerId: developer.id, rail: "base-usdc", address: destination.address });
    }
    t.policy.developerId = developer.id;
    t.policy.developerLogin = developer.login;
    t.policy.assignment = { generation: assignment.generation, marker: assignment.marker };
    t.policyHash = hash(t.policy);
    t.developerAccepted = true;
    t.prNumber = null;
    t.verdict = null;
    t.evidence = null;
    t.marketSubmission = null;
    note(t, `${developer.login} claimed the bounty (assignment ${assignment.marker}); the delivery clock starts once the assignment is confirmed.`);
    this.store.save(t);
    this.store.enqueue(t.id);
  }
  /** Return the task to its funded, unassigned agreement after the chain cleared the assignment. */
  unassign(t: Task, reason: string) {
    if (!t.fundingPolicy || !t.fundingPolicyHash || !t.policy.market) throw new Error("Not a fixed-deadline bounty");
    if (t.payment.state !== "NotRequested") throw new Error("Payment already started; the assignment cannot be released");
    t.policy = structuredClone(t.fundingPolicy);
    t.policyHash = t.fundingPolicyHash;
    delete t.payout;
    t.developerAccepted = false;
    t.prNumber = null;
    t.verdict = null;
    t.evidence = null;
    t.marketSubmission = null;
    note(t, reason);
    this.store.save(t);
    this.store.enqueue(t.id);
  }
  accept(t: Task, role: "client" | "developer", policyHash: unknown) {
    if (policyHash !== t.policyHash)
      throw new Error("Accept the exact policy version displayed");
    if (!t.openBounty) verifyTaskPayout(t);
    else {
      validateFundingPolicy(t);
      if (role !== "client")
        throw new Error("Developers accept open bounties by claiming them");
    }
    const field = role === "client" ? "clientAccepted" : "developerAccepted";
    if (!t[field]) {
      t[field] = true;
      note(
        t,
        `${role === "client" ? "Client" : "Developer"} accepted the criteria and automatic release policy.`,
      );
    }
    this.store.transaction(() => {
      this.store.save(t);
      this.store.enqueue(t.id);
    });
  }
  fund(t: Task) {
    if (t.mode !== "simulation")
      throw new Error(
        "Sandbox funding is confirmed from Monerium; use the deposit instructions.",
      );
    if (
      !t.clientAccepted ||
      (!t.developerAccepted && !t.openBounty) ||
      t.disputed
    )
      throw new Error("Both parties must accept before funding");
    if (!t.openBounty || t.policy.developerId !== 0) verifyTaskPayout(t);
    else validateFundingPolicy(t);
    if (!t.funded) {
      t.funded = true;
      t.fundedAt = new Date().toISOString();
      note(
        t,
        "Simulated escrow funded. No bank transfer or real money involved.",
      );
    }
    this.store.transaction(() => {
      this.store.save(t);
      this.store.enqueue(t.id);
    });
  }
  bindPr(t: Task, number: unknown) {
    if (!t.clientAccepted || !t.developerAccepted || !t.funded)
      throw new Error("Accept and fund the task before linking a PR");
    if (!Number.isSafeInteger(number) || Number(number) <= 0)
      throw new Error("Enter a valid PR number");
    if (t.prNumber !== null && t.prNumber !== number)
      throw new Error(
        "The task is already bound to a PR. Create a new task to change it.",
      );
    t.prNumber = Number(number);
    note(
      t,
      `PR #${t.prNumber} linked. Verification will use GitHub's current records.`,
    );
    this.store.transaction(() => {
      this.store.save(t);
      this.store.enqueue(t.id);
    });
  }
  simulate(t: Task, action: unknown, role: "client" | "developer") {
    if (t.mode !== "simulation" || t.githubMode !== "fixture")
      throw new Error(
        "Fixture controls are disabled for live GitHub and sandbox tasks",
      );
    if (!t.prNumber || t.disputed || t.payment.state !== "NotRequested")
      throw new Error("This task cannot change fixture state");
    if (action === "merged") {
      if (role !== "client" || t.fixture !== "ready")
        throw new Error(
          "The client may simulate a merge only after checks pass",
        );
    } else if (
      role !== "developer" ||
      !["failed", "ready", "tampered"].includes(String(action)) ||
      t.fixture === "merged"
    )
      throw new Error("Invalid fixture action");
    t.fixture = action as Task["fixture"];
    note(t, `Simulated GitHub event: ${action}.`);
    this.store.transaction(() => {
      this.store.save(t);
      this.store.enqueue(t.id);
    });
  }
  async dispute(t: Task, role: "client" | "developer" = "client") {
    if (t.payment.state !== "NotRequested")
      throw new Error(
        "Release is already authorized; it cannot be cancelled from this screen.",
      );
    await this.payments.dispute(t, role);
    t.disputed = true;
    note(t, "A dispute blocks automatic release.");
    this.store.save(t);
  }
  /**
   * Dispatch due tasks with bounded concurrency. Each task runs under its own lock and is re-read
   * inside it; a slow provider for one task only occupies one worker slot.
   */
  async tick(): Promise<void> {
    this.lastTickAt = Date.now();
    const free = this.concurrency - this.inflight.size;
    if (free <= 0) return;
    const ids = this.store.due(free, this.inflight);
    await Promise.all(ids.map((id) => {
      this.inflight.add(id);
      const started = Date.now();
      return this.exclusive(`task:${id}`, () => this.process(id))
        .catch((error) => log("error", "worker.unhandled", { error }))
        .finally(() => {
          this.inflight.delete(id);
          metrics.observe("worker_task_ms", Date.now() - started);
          if (this.continuous) setImmediate(() => void this.tick().catch(() => {}));
        });
    }));
  }
  private async process(id: string): Promise<void> {
    let task: Task;
    try {
      task = this.store.get(id);
    } catch {
      this.store.done(id);
      return;
    }
    try {
      if (hash(task.policy) !== task.policyHash)
        throw new Error("Stored policy integrity check failed");
      if (
        !task.clientAccepted ||
        (!task.developerAccepted && !task.openBounty) ||
        task.payment.state === "Processed"
      ) {
        // A confirmed payment still has to be recorded on the deadline agreement (Paid).
        if (task.payment.state === "Processed" && this.lifecycle?.owns(task)) await this.lifecycle.step(task);
        this.store.done(id);
        return;
      }
      if (task.openBounty) validateFundingPolicy(task);
      if (!task.openBounty || task.policy.developerId !== 0)
        verifyTaskPayout(task);
      // Reconcile with the chain first: after a crash between signing and the local save, sync
      // reports the existing payout and release is not attempted again.
      let authorized = false;
      {
        await this.payments.prepare(task);
        const before = task.funded;
        await this.payments.sync(task);
        if (!before && task.funded) {
          task.fundedAt = new Date().toISOString();
          note(task, task.policy.paymentRail === "base-usdc" ? "USDC deposit confirmed on Base Sepolia and recorded in NEAR escrow." : "Monerium deposit confirmed in escrow.");
        }
        authorized = task.payment.state === "Authorized";
        if (!task.disputed && authorized) await this.payments.release(task);
      }
      // Fixed-deadline bounties: one common lifecycle for both rails (funding, assignment binding,
      // submission relay, withdrawal, expiry, settlement confirmation). Adapters do the rail calls.
      const market = this.lifecycle?.owns(task) ? this.lifecycle : undefined;
      if (market && !task.disputed) await market.step(task);
      if (task.disputed) {
        this.store.save(task);
        if(task.refund?.state === "Processed") this.store.done(id);
        else this.store.wait(id, Math.min(60_000,this.waitFor(task)));
        return;
      }
      if (
        !authorized &&
        task.funded &&
        task.prNumber &&
        task.payment.state === "NotRequested"
      ) {
        // Only this task's lock is held here: GitHub latency never blocks other tasks.
        const evidence =
          task.githubMode === "live"
            ? await this.github.evidence(task)
            : fixtureEvidence(task);
        // Linking a PR that was merged before the mandate was created cannot earn a reward.
        // Every developer payout requires the agreed checks and creator merge.
        const verdict = market ? evaluateMergePolicy(task, evidence) : evaluateRelease(task, evidence);
        if (
          evidence.merged &&
          (!evidence.mergedAt ||
            !Number.isFinite(Date.parse(evidence.mergedAt)))
        ) {
          verdict.status = "blocked";
          verdict.reasons.unshift(
            "GitHub did not supply a valid merge timestamp.",
          );
        }
        if (
          evidence.mergedAt &&
          evidence.mergedAt < (task.fundedAt ?? task.createdAt)
        ) {
          verdict.status = "blocked";
          verdict.reasons.unshift(
            "The PR merged before this task's funding was confirmed.",
          );
        }
        market?.gate(task, evidence, verdict);
        if (
          task.verdict?.status !== verdict.status ||
          task.verdict?.reasons.join() !== verdict.reasons.join()
        )
          note(
            task,
            verdict.status === "eligible"
              ? "The merged PR meets every agreed verification condition."
              : verdict.reasons.join(" "),
          );
        task.evidence = evidence;
        task.verdict = verdict;
        if (verdict.status === "eligible") {
          task.payment.state = "Authorized";
          task.payment.error = null;
          note(
            task,
            "Automatic release authorized by the accepted policy.",
          );
          // Commit the unique release record (CAS-protected) before any payment call.
          if (market) market.authorize(task, verdict.evidenceHash);
          else this.store.authorize(task, verdict.evidenceHash);
          await this.payments.release(task);
          if (market && (task.payment.state as string) === "Processed") await market.step(task);
        }
      }
      if (task.payment.state !== "NeedsAttention")
        task.payment.error = null;
      this.store.save(task);
      if (this.store.get(id).payment.state === "Processed") this.store.done(id);
      else {
        // Expiry and relay deadlines are scheduled exactly; they do not depend on an open page.
        const due = market?.nextCheck(task);
        this.store.wait(id, Math.max(1000, Math.min(this.waitFor(task), due ? due - Date.now() : Infinity)));
      }
    } catch (error) {
      if (error instanceof StaleWriteError) {
        // Someone else saved this task meanwhile: drop this copy and re-evaluate from fresh state.
        metrics.inc("worker_stale_writes_total");
        this.store.defer(id, 1000, "Re-evaluating after a concurrent update");
        return;
      }
      const message =
        error instanceof Error ? error.message : "Task worker failed";
      if (error instanceof PaymentPending) {
        // A confirmed prerequisite can still be settling. Clear historical failure
        // backoff and follow normal payment polling; preserve the frozen intent.
        this.store.wait(id, this.waitFor(task));
      } else if (error instanceof ProviderUnavailable) {
        // Provider-wide condition: wait for it without growing this task's failure streak.
        metrics.inc("worker_deferred_total", { provider: error.provider });
        this.store.defer(id, Math.max(5000, error.retryAt - Date.now()) + Math.round(Math.random() * 5000), message);
      } else {
        metrics.inc("worker_failures_total");
        this.store.retry(id, message, backoff(this.store.attempts(id), task.mode === "simulation" ? 2000 : 20_000, 900_000));
      }
      try {
        // Keep this pass's progress (as before); fall back to the stored copy if it moved on.
        task.payment.error = message;
        try {
          this.store.save(task);
        } catch (stale) {
          if (!(stale instanceof StaleWriteError)) throw stale;
          const fresh = this.store.get(id);
          fresh.payment.error = message;
          this.store.save(fresh);
        }
      } catch (saveError) {
        log("warn", "worker.error_not_saved", { error: saveError });
      }
    }
  }
  /** Safety net: queue active tasks that fell out of the queue, without touching existing schedules. */
  reconcile(): number {
    let added = 0;
    for (const t of this.store.all())
      if (
        t.clientAccepted &&
        (t.developerAccepted || t.openBounty) &&
        t.refund?.state !== "Processed" &&
        t.payment.state !== "Processed" &&
        this.store.ensureQueued(t.id)
      )
        added++;
    return added;
  }
}

/** Assignment may add a developer and payout; it cannot change what the client funded. */
export function validateFundingPolicy(t: Task) {
  if (!t.openBounty) return;
  const base = t.fundingPolicy;
  if (
    !base ||
    hash(base) !== t.fundingPolicyHash ||
    base.assignmentRule !== "first-eligible-github-claim"
  )
    throw new Error("Funding mandate integrity check failed");
  const economic = (p: TaskPolicy) => {
    const {
      developerId: _id,
      developerLogin: _login,
      recipient: _recipient,
      payoutCommitment: _p,
      assignment: _a,
      ...rest
    } = p;
    return rest;
  };
  if (hash(economic(base)) !== hash(economic(t.policy)))
    throw new Error("Funded criteria or economics changed");
}
