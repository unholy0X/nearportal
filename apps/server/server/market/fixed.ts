// Fixed price + delivery deadline + exclusive assignment: the ONE business lifecycle shared by the
// bank (Monerium sandbox) and USDC (Base Sepolia) rails. Rail adapters (rail.ts) perform escrow
// calls; this module owns exclusivity, generations, deadlines, submission admissibility,
// transitions, expiry and settlement authorization. HTTP handlers (and a future MCP server) call
// the command methods; the task worker calls `step`.
//
// Time rules (server/chain time only; browser and Git timestamps carry no authority):
// - The delivery clock starts at the chain-confirmed binding time `acceptedAt`;
//   `deadline = acceptedAt + deliveryHours`. Until confirmation the UI shows "Assignment processing"
//   and no submission is accepted.
// - A submission is timely when the server receives it at `receivedAt <= deadline` (inclusive).
// - The 15-minute relay grace only lets the worker record an already-received timely submission on
//   chain. It never extends development time.
// - Without a timely submission, the assignment expires when `now > deadline + grace`: chain first,
//   then the engine. Funds stay locked; nothing is refunded or transferred.
// - A submitted assignment never expires and survives late checks/review.
import { MARKET_RELAY_GRACE_MS, marketTerms, newMarket, type Market } from "../portal/market.ts";
import type { MarketStore } from "../portal/market-store.ts";
import type { TaskService } from "../tasks/service.ts";
import type { Task, PrEvidence, Verdict } from "../tasks/domain.ts";
import { note } from "../tasks/domain.ts";
import { hasTaskMarker } from "../portal/judge.ts";
import { deliverySeconds, type MarketRail } from "./rail.ts";
import type { Bounty, User } from "../portal/store.ts";
import { log } from "../ops/log.ts";
import { metrics } from "../ops/metrics.ts";

type GitHubReader = { get<T>(path: string): Promise<T> };
export interface FixedDeps {
  markets: MarketStore;
  tasks: TaskService;
  rail: (t: Task) => Promise<MarketRail | null>;
  ownerGitHub: (ownerId: number) => GitHubReader;
  environment: string;
  now?: () => number;
}
// Definite refusals of `assign_developer` (contracts/common/src/errors.rs): nothing was bound.
const definite = (e: unknown) => /Assignment generation mismatch|Developer already bound|Funded unsettled bounty required|Recipient matches client refund|Invalid short IBAN|Invalid recipient|No such bounty|Invalid assignment hash/.test(String((e as Error)?.message ?? e));

export class FixedBounties {
  readonly now: () => number;
  constructor(readonly deps: FixedDeps) {
    this.now = deps.now ?? (() => Date.now());
  }
  owns(t: Task) {
    return Boolean(t.policy.market ?? t.fundingPolicy?.market) && Boolean(t.portalId);
  }
  market(bountyId: string) {
    return this.deps.markets.find(bountyId);
  }
  /** Create the versioned agreement once the funding policy hash exists (preparation job). */
  ensureMarket(b: Bounty, t: Task) {
    if (!b.marketTerms || b.marketTerms.kind !== "fixed") throw new Error("Not a fixed-deadline bounty");
    const terms = marketTerms(b.marketTerms, b.amountCents);
    return this.deps.markets.ensure(b.id, newMarket(b.code, b.ownerId, t.fundingPolicyHash!, terms));
  }

  // ---------------- Commands (authenticated callers; identity/role checked by the caller) ----------------

  /**
   * Exclusive claim. The caller has authenticated the user, checked repository access, and supplies
   * the server-owned payout destination for the bounty's rail. Exactly one of concurrent claims wins
   * (task lock + market compare-and-swap); the delivery clock does not start yet.
   */
  claim(b: Bounty, user: User, input: { acceptedPolicyHash: unknown; expectedRevision?: unknown }, destination: { kind: "bank"; payout: Record<string, string>; payoutVersion: string } | { kind: "usdc"; address: string; proofVersion: string }, repositoryAccess: boolean, within?: (market: Market) => void) {
    const t = this.deps.tasks.store.get(b.taskId!);
    const m = this.deps.markets.get(b.id);
    if (!t.funded || m.phase === "unfunded") throw new Error("This bounty is not funded yet; it cannot be claimed");
    if (typeof input.acceptedPolicyHash !== "string") throw new Error("Review and accept the funded terms first");
    const expected = typeof input.expectedRevision === "number" ? input.expectedRevision : m.revision;
    const next = this.deps.markets.apply(b.id, expected, {
      type: "claim",
      acceptedPolicyHash: input.acceptedPolicyHash,
      person: { userId: user.id, login: user.login, repositoryAccess, payoutVersion: destination.kind === "bank" ? destination.payoutVersion : destination.proofVersion },
    }, this.now(), (market) => {
      const fresh = this.deps.tasks.store.get(t.id);
      this.deps.tasks.assign(fresh, { id: user.id, login: user.login }, destination.kind === "bank" ? { kind: "bank", payout: destination.payout } : { kind: "usdc", address: destination.address }, { generation: market.assignment!.generation, marker: market.assignment!.marker });
      within?.(market); // e.g. the command receipt commits atomically with the assignment
    });
    metrics.inc("market_commands_total", { command: "claim" });
    return next;
  }

  /**
   * Register the exact PR head for the current assignment. Reads GitHub with the owner's credential,
   * verifies repository, author, branch, marker/generation and real changes, then durably records
   * the server reception time before answering. It is not a validation of the work.
   */
  async submit(b: Bounty, user: User, input: { prNumber: unknown; expectedRevision?: unknown }, receivedAt = this.now()) {
    const number = Number(input.prNumber);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Enter a valid pull request number");
    const m = this.deps.markets.get(b.id), a = m.assignment;
    if (!a || a.userId !== user.id) throw new Error("Only the assigned developer can submit work for this bounty");
    if (!a.confirmedAt) throw new Error("The assignment is still being confirmed; submit once the deadline appears");
    const t = this.deps.tasks.store.get(b.taskId!);
    // The HTTP caller may capture reception before waiting for the task lock. This is always a
    // server timestamp, never a field from the request. GitHub latency does not change it either.
    const pr = await this.deps.ownerGitHub(b.ownerId).get<any>(`/repos/${b.repository}/pulls/${number}`);
    const problems: string[] = [];
    if (pr?.user?.id !== user.id) problems.push("The pull request must be opened by the assigned developer.");
    if (pr?.base?.repo?.id !== t.policy.repositoryId) problems.push("The pull request targets another repository.");
    if (pr?.base?.ref !== t.policy.branch) problems.push(`The pull request must target ${t.policy.branch}.`);
    if (!hasTaskMarker(String(pr?.body ?? ""), a.marker)) problems.push(`Add this exact line to the PR description: NearPortal-Task: ${a.marker}`);
    if (pr?.state !== "open" && !pr?.merged) problems.push("The pull request is closed.");
    if (!(Number(pr?.changed_files) > 0) || !(Number(pr?.additions) + Number(pr?.deletions) > 0)) problems.push("The pull request contains no changes.");
    if (!/^[a-f0-9]{40}$/.test(String(pr?.head?.sha ?? ""))) problems.push("GitHub did not report a valid head commit.");
    if (Date.parse(pr?.created_at ?? "") < a.acceptedAt - 60_000) problems.push("Open a new pull request for this assignment; earlier pull requests cannot be reused.");
    if (problems.length) throw new Error(problems.join(" "));
    const expected = typeof input.expectedRevision === "number" ? input.expectedRevision : m.revision;
    const next = this.deps.markets.apply(b.id, expected, { type: "submit", userId: user.id, generation: a.generation, marker: a.marker, prNumber: number, headSha: pr.head.sha }, receivedAt, (market) => {
      const fresh = this.deps.tasks.store.get(t.id);
      const sub = market.assignment!.submission!;
      if (fresh.marketSubmission?.headSha === sub.headSha && fresh.marketSubmission.generation === a.generation) return;
      fresh.prNumber = sub.prNumber;
      fresh.marketSubmission = { generation: a.generation, prNumber: sub.prNumber, headSha: sub.headSha, receivedAt: sub.receivedAt, relayedAt: null };
      fresh.verdict = null;
      note(fresh, `PR #${sub.prNumber} submitted for ${a.marker} at ${new Date(sub.receivedAt).toISOString()} (commit ${sub.headSha.slice(0, 12)}). Verification and review follow.`);
      this.deps.tasks.store.save(fresh);
      this.deps.tasks.store.enqueue(fresh.id);
    });
    this.deps.markets.record({ bountyId: b.id, generation: a.generation, userId: user.id, kind: "submission-received", at: receivedAt, environment: this.deps.environment, cause: "developer" });
    metrics.inc("market_commands_total", { command: "submit" });
    return next;
  }

  /** The developer releases an unsubmitted, confirmed assignment. The chain is cleared first. */
  requestWithdraw(b: Bounty, user: User, input: { generation: unknown; expectedRevision?: unknown }) {
    const m = this.deps.markets.get(b.id);
    if (typeof input.generation !== "number") throw new Error("Confirm which assignment you are releasing");
    const expected = typeof input.expectedRevision === "number" ? input.expectedRevision : m.revision;
    const next = this.deps.markets.apply(b.id, expected, { type: "request-withdraw", userId: user.id, generation: input.generation }, this.now(), () => {
      this.deps.tasks.store.enqueue(b.taskId!);
    });
    metrics.inc("market_commands_total", { command: "withdraw" });
    return next;
  }

  // ---------------- Worker (under the task lock; chain read before every write) ----------------

  async step(t: Task) {
    const bountyId = t.portalId!;
    let m = this.deps.markets.find(bountyId);
    if (!m) return;
    const rail = await this.deps.rail(t);
    if (!rail) throw new Error("No payment rail supports deadline bounties for this task");
    if (m.phase === "paused") return;
    // 0. The deadline terms are fixed by `create_bounty` before any deposit address is shown.
    if (m.phase === "unfunded") {
      const created = await rail.read(t);
      if (!created) return;
      if (created.deliverySeconds !== deliverySeconds(t)) {
        this.deps.markets.applyLatest(bountyId, { type: "pause" }, this.now());
        throw new Error("The escrow's delivery window differs from the funded terms; paused for review");
      }
      // 1. Funding: only the exact confirmed deposit opens claims; surplus is tracked by the rail.
      if (!t.funded) return;
      m = this.deps.markets.applyLatest(bountyId, { type: "fund", confirmedCents: t.policy.amountCents }, this.now());
    }
    const a = m.assignment;
    // 2. Settlement confirmation (Paid only after the rail confirmed the payout).
    if (m.phase === "payment-processing" && t.payment.state === "Processed" && m.settlement) {
      this.deps.markets.applyLatest(bountyId, { type: "payment-confirmed", settlementId: m.settlement.id, leg: "developer" }, this.now());
      if (a) this.deps.markets.record({ bountyId, generation: a.generation, userId: a.userId, kind: "payment-confirmed", at: this.now(), environment: this.deps.environment, cause: "settlement" });
      return;
    }
    if (!a || m.phase === "payment-processing" || m.phase === "paid") return;
    const chain = await rail.read(t);
    if (!chain) {
      this.deps.markets.applyLatest(bountyId, { type: "pause" }, this.now());
      throw new Error("The escrow has no deadline terms for this funded bounty; paused for review");
    }
    const onChain = chain.assignment;
    // 3. Assignment binding: reconcile, then (re)send; generations make repetition harmless.
    if (!a.confirmedAt) {
      if (onChain && onChain.generation === a.generation) {
        if (onChain.developerId !== a.userId || onChain.policyHash !== t.policyHash || onChain.deadlineMs === null) {
          this.deps.markets.applyLatest(bountyId, { type: "pause" }, this.now());
          throw new Error("The escrow holds a different assignment than this bounty; paused for review");
        }
        this.deps.markets.applyLatest(bountyId, { type: "confirm-assignment", generation: a.generation, acceptedAt: onChain.startedAtMs, deadline: onChain.deadlineMs }, Math.max(this.now(), onChain.startedAtMs));
        this.deps.markets.acknowledge(bountyId, ["claim"], Number.MAX_SAFE_INTEGER);
        this.deps.markets.record({ bountyId, generation: a.generation, userId: a.userId, kind: "assignment-confirmed", at: onChain.startedAtMs, environment: this.deps.environment, cause: "developer" });
        note(t, `Assignment ${a.marker} confirmed on chain. Delivery deadline: ${new Date(onChain.deadlineMs).toISOString()}.`);
        this.deps.tasks.store.save(t);
        return;
      }
      if (onChain || chain.generation >= a.generation) {
        this.deps.markets.applyLatest(bountyId, { type: "pause" }, this.now());
        throw new Error("The escrow assignment generation does not match; paused for review");
      }
      try {
        await rail.bind(t, { generation: a.generation, developerId: a.userId, policyHash: t.policyHash });
      } catch (error) {
        // Re-read: a timeout may still have bound the assignment. Only a definite refusal reopens.
        const after = await rail.read(t).catch(() => null);
        if (after?.assignment?.generation === a.generation) return; // confirmed on the next pass
        if (after && definite(error)) {
          this.deps.markets.applyLatest(bountyId, { type: "binding-failed", generation: a.generation }, this.now(), () => {
            this.deps.tasks.unassign(t, `The escrow did not accept assignment ${a.marker} (${(error as Error).message}). The bounty is available again; this is not counted against the developer.`);
          });
          return;
        }
        throw error;
      }
      return;
    }
    // A crash can occur after chain clear but before the local transaction commits.
    // Reconcile only the exact cleared generation with no submission or settlement.
    if (!onChain && chain.generation === a.generation && !chain.released && !a.submission &&
        (a.withdrawRequestedAt || this.now() > a.deadline + MARKET_RELAY_GRACE_MS)) {
      const withdrawn = Boolean(a.withdrawRequestedAt);
      this.deps.markets.applyLatest(bountyId, withdrawn
        ? { type: "withdraw", userId: a.userId, generation: a.generation }
        : { type: "expire" }, this.now(), () => {
          this.deps.tasks.unassign(t, `Assignment ${a.marker} ${withdrawn ? 'withdrawn' : 'expired'} on chain. The bounty is available again; funds stay secured.`);
        });
      this.deps.markets.record({ bountyId, generation: a.generation, userId: a.userId,
        kind: withdrawn ? "assignment-withdrawn" : "assignment-expired", at: this.now(),
        environment: this.deps.environment, cause: withdrawn ? "developer" : "deadline" });
      return;
    }
    if (!onChain || onChain.generation !== a.generation) {
      this.deps.markets.applyLatest(bountyId, { type: "pause" }, this.now());
      throw new Error("The confirmed assignment is missing from the escrow; paused for review");
    }
    // 4. Relay the timely submission (received <= deadline) within the bounded grace (both rails
    // refuse it later). A head updated before the deadline is relayed the same way; the chain
    // keeps the latest timely one.
    if (a.submission && onChain.headSha !== a.submission.headSha && t.marketSubmission?.headSha === a.submission.headSha) {
      if (this.now() > a.deadline + MARKET_RELAY_GRACE_MS) throw new Error("A timely submission could not be recorded on chain within the relay window; manual review required (not the developer's fault)");
      try {
        await rail.recordSubmission(t, { generation: a.generation, policyHash: t.policyHash, headSha: a.submission.headSha, observedAtMs: a.submission.receivedAt });
      } catch (error) {
        const after = await rail.read(t).catch(() => null);
        if (after?.assignment?.headSha !== a.submission.headSha) throw error;
      }
      const after = await rail.read(t);
      if (after?.assignment?.headSha === a.submission.headSha) {
        t.marketSubmission = { ...t.marketSubmission, relayedAt: this.now() };
        note(t, `Submission ${a.submission.headSha.slice(0, 12)} recorded on chain for ${a.marker}.`);
        this.deps.tasks.store.save(t);
        this.deps.markets.acknowledge(bountyId, ["submit"], Number.MAX_SAFE_INTEGER);
      }
      return;
    }
    if (a.submission && onChain.headSha === a.submission.headSha && t.marketSubmission && !t.marketSubmission.relayedAt) {
      // Recorded by an earlier, interrupted pass: acknowledge it locally.
      t.marketSubmission = { ...t.marketSubmission, relayedAt: this.now() };
      this.deps.tasks.store.save(t);
      return;
    }
    // 5. Developer withdrawal: clear the chain, then reopen.
    if (a.withdrawRequestedAt && !a.submission) {
      if (onChain) await rail.withdraw(t, a.generation);
      const after = await rail.read(t);
      if (!after || after.generation !== a.generation || after.released) throw new Error("Cannot verify the cleared escrow assignment; retry reconciliation");
      if (after.assignment) return;
      this.deps.markets.applyLatest(bountyId, { type: "withdraw", userId: a.userId, generation: a.generation }, this.now(), () => {
        this.deps.tasks.unassign(t, `${a.login} released assignment ${a.marker}. The bounty is available again; funds stay secured.`);
      });
      this.deps.markets.record({ bountyId, generation: a.generation, userId: a.userId, kind: "assignment-withdrawn", at: this.now(), environment: this.deps.environment, cause: "developer" });
      return;
    }
    // 6. Expiry without a timely submission: chain first (permissionless after deadline + grace).
    if (!a.submission && this.now() > a.deadline + MARKET_RELAY_GRACE_MS) {
      if (onChain.headSha) {
        this.deps.markets.applyLatest(bountyId, { type: "pause" }, this.now());
        throw new Error("The escrow recorded a submission the server does not know; paused for review");
      }
      try {
        await rail.expire(t, a.generation);
      } catch (error) {
        // The chain clock may trail the server clock; an uncertain outcome is re-read below.
        if (!/window still open|No active assignment|Assignment generation mismatch/.test(String((error as Error)?.message))) {
          const check = await rail.read(t).catch(() => null);
          if (check?.assignment) throw error;
        }
      }
      const after = await rail.read(t);
      if (!after || after.generation !== a.generation || after.released) throw new Error("Cannot verify the cleared escrow assignment; retry reconciliation");
      if (after.assignment) return;
      this.deps.markets.applyLatest(bountyId, { type: "expire" }, this.now(), () => {
        this.deps.tasks.unassign(t, `Assignment ${a.marker} expired without a timely submission. The bounty is available again; funds stay secured and nothing was transferred.`);
      });
      this.deps.markets.record({ bountyId, generation: a.generation, userId: a.userId, kind: "assignment-expired", at: this.now(), environment: this.deps.environment, cause: "deadline" });
      log("info", "market.expired", { bounty: bountyId, generation: a.generation });
    }
  }

  /** Release gate: exact timely head, current generation, and the chain recorded that submission. */
  gate(t: Task, evidence: PrEvidence, verdict: Verdict) {
    const m = t.portalId ? this.deps.markets.find(t.portalId) : null;
    const a = m?.assignment, sub = t.marketSubmission;
    const block = (reason: string) => {
      if (verdict.status === "eligible") verdict.status = "pending";
      verdict.reasons.unshift(reason);
    };
    if (!m || !a || !sub || sub.generation !== a.generation || a.submission?.headSha !== sub.headSha) return block("No timely submission is registered for the current assignment.");
    if (evidence.prNumber !== sub.prNumber) return block("This pull request is not the submitted one.");
    if (evidence.headSha !== sub.headSha) {
      verdict.status = "blocked";
      verdict.reasons.unshift(`The pull request head changed after submission (submitted ${sub.headSha.slice(0, 12)}, now ${evidence.headSha.slice(0, 12)}). Only the submitted commit can be paid.`);
      return;
    }
    if (!sub.relayedAt) return block("The submission is being recorded on the escrow.");
    if (m.phase !== "in-review") return block("The assignment is not in review.");
  }

  authorize(t: Task, evidenceHash: string) {
    const bountyId = t.portalId!;
    const m = this.deps.markets.get(bountyId), a = m.assignment!;
    this.deps.markets.applyLatest(bountyId, { type: "authorize-payment", generation: a.generation, headSha: t.marketSubmission!.headSha, verified: true, settlementId: `settle-${t.id}-g${a.generation}` }, this.now(), () => {
      this.deps.tasks.store.authorizeWithin(t, evidenceHash);
    });
  }
  settled(_t: Task) {
    /* settlement confirmation is reconciled in step() from the rail's payout state */
  }
  nextCheck(t: Task) {
    const m = t.portalId ? this.deps.markets.find(t.portalId) : null;
    const a = m?.assignment;
    if (!a) return null;
    if (!a.confirmedAt) return this.now() + 15_000;
    if (a.withdrawRequestedAt || (a.submission && !t.marketSubmission?.relayedAt)) return this.now() + 5_000;
    if (!a.submission) {
      const due = a.deadline + MARKET_RELAY_GRACE_MS + 1_000;
      return due > this.now() ? due : this.now() + 30_000;
    }
    return null;
  }

  // ---------------- Views ----------------

  /** Public view: no payout version, no bids; the server clock is included for countdowns. */
  view(b: Bounty, viewerId?: number) {
    const m = this.deps.markets.find(b.id);
    if (!m) return null;
    const a = m.assignment;
    const mine = Boolean(a && viewerId === a.userId);
    return {
      kind: m.terms.kind,
      phase: m.phase,
      revision: m.revision,
      generation: m.generation,
      deliveryHours: m.terms.deliveryHours,
      relayGraceMinutes: MARKET_RELAY_GRACE_MS / 60_000,
      fundedAt: m.fundedAt,
      serverNow: this.now(),
      assignment: a
        ? {
            generation: a.generation,
            marker: a.marker,
            userId: a.userId,
            login: a.login,
            confirmed: Boolean(a.confirmedAt),
            acceptedAt: a.confirmedAt ? a.acceptedAt : null,
            deadline: a.confirmedAt ? a.deadline : null,
            withdrawRequested: Boolean(a.withdrawRequestedAt),
            submission: a.submission ? { prNumber: a.submission.prNumber, headSha: a.submission.headSha, receivedAt: a.submission.receivedAt } : null,
            mine,
          }
        : null,
      history: m.history.map((h) => ({ generation: h.generation, reason: h.reason, at: h.at, mine: viewerId === h.userId })),
      settlement: m.settlement ? { processed: m.settlement.developerProcessed } : null,
    };
  }
}
export type FixedView = NonNullable<ReturnType<FixedBounties["view"]>>;
export type { Market };
