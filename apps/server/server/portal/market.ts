/** Versioned bounty terms and deterministic lifecycle. Times are server UTC milliseconds.
 * No caller-supplied eligibility, clock, SHA, or payment result is trusted at the HTTP boundary.
 * All commands must run under one durable compare-and-swap transaction.
 */
export interface MarketTerms {
  version: 1;
  kind: "fixed" | "auction";
  budgetCents: number;
  deliveryHours: number;
  biddingHours: number;
  confirmationHours: number;
}
export interface Eligibility {
  userId: number;
  login: string;
  payoutVersion: string;
  repositoryAccess: boolean;
}
export interface Bid {
  id: string;
  userId: number;
  login: string;
  amountCents: number;
  payoutVersion: string;
  acceptedPolicyHash: string;
  submittedAt: number;
  status: "active" | "withdrawn" | "offered" | "declined" | "timed-out" | "ineligible" | "accepted";
}
export interface Submission {
  prNumber: number;
  headSha: string;
  receivedAt: number;
}
export interface Assignment {
  generation: number;
  userId: number;
  login: string;
  rewardCents: number;
  payoutVersion: string;
  /** Claim request time until confirmed; then the authoritative (chain) start of delivery. */
  acceptedAt: number;
  /** Provisional until confirmedAt is set; then the authoritative inclusive delivery limit. */
  deadline: number;
  /** Null while the exclusive assignment is being bound on chain ("assignment processing"). */
  confirmedAt?: number | null;
  /** The developer asked to release the claim; the chain is cleared before the bounty reopens. */
  withdrawRequestedAt?: number | null;
  marker: string;
  submission: Submission | null;
}
export interface Market {
  version: 1;
  revision: number;
  code: string;
  ownerId: number;
  policyHash: string;
  terms: MarketTerms;
  phase: "unfunded" | "available" | "bidding" | "offered" | "in-progress" | "in-review" | "payment-processing" | "paid" | "paused";
  fundedAt: number | null;
  biddingClosesAt: number | null;
  round: number;
  generation: number;
  bids: Bid[];
  offer: { bidId: string; expiresAt: number } | null;
  assignment: Assignment | null;
  history: { generation: number; userId: number; reason: "expired" | "withdrawn" | "binding-failed"; at: number }[];
  settlement: { id: string; developerCents: number; refundCents: number; developerProcessed: boolean; refundProcessed: boolean } | null;
}
const HOUR = 3_600_000;
export const MARKET_RELAY_GRACE_MS = 15 * 60_000;
export const MARKET_CLOCK_SKEW_MS = 2 * 60_000;
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const int = (n: unknown, min: number, max: number, label: string): number => {
  assert(typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max, `Invalid ${label}`);
  return n;
};
export function marketTerms(input: unknown, budgetCents: number): MarketTerms {
  assert(input && typeof input === "object" && !Array.isArray(input), "Choose fixed reward or sealed bids");
  const i = input as Record<string, unknown>;
  assert(i.kind === "fixed" || i.kind === "auction", "Invalid bounty mode");
  assert(i.version === undefined || i.version === 1, "Unsupported bounty terms version");
  return {
    version: 1, kind: i.kind,
    budgetCents: int(budgetCents, 1, 100_000, "budget"),
    deliveryHours: int(i.deliveryHours, 1, 24 * 90, "delivery window"),
    biddingHours: i.kind === "auction" ? int(i.biddingHours, 1, 24 * 30, "bidding window") : 0,
    confirmationHours: i.kind === "auction" ? int(i.confirmationHours ?? 24, 1, 72, "winner confirmation window") : 0,
  };
}
function time(now: number) { return int(now, 1, Number.MAX_SAFE_INTEGER - 100 * 24 * HOUR, "server time"); }
export function newMarket(code: string, ownerId: number, policyHash: string, terms: MarketTerms): Market {
  assert(/^NP-[A-F0-9]{10}$/.test(code), "Invalid task code");
  int(ownerId, 1, Number.MAX_SAFE_INTEGER, "owner");
  assert(/^[a-f0-9]{64}$/.test(policyHash), "Invalid accepted policy hash");
  const normalized = marketTerms(terms, terms.budgetCents);
  return { version: 1, revision: 0, code, ownerId, policyHash, terms: normalized, phase: "unfunded", fundedAt: null, biddingClosesAt: null, round: 1, generation: 0, bids: [], offer: null, assignment: null, history: [], settlement: null };
}
function eligible(m: Market, person: Eligibility) {
  int(person.userId, 1, Number.MAX_SAFE_INTEGER, "GitHub identity");
  assert(person.userId !== m.ownerId, "The owner cannot claim their own bounty");
  assert(person.repositoryAccess, "Repository access is required before bidding or claiming");
  assert(person.login && person.payoutVersion, "Save payout details before accepting an assignment");
}
function policy(m: Market, acceptedPolicyHash: string) {
  assert(acceptedPolicyHash === m.policyHash, "Terms changed. Review the funded agreement again");
}
export type Command =
  | { type: "fund"; confirmedCents: number }
  | { type: "claim"; person: Eligibility; acceptedPolicyHash: string }
  | { type: "bid"; person: Eligibility; acceptedPolicyHash: string; bidId: string; amountCents: number }
  | { type: "confirm-assignment"; generation: number; acceptedAt: number; deadline: number }
  | { type: "withdraw-bid"; userId: number }
  // The trusted worker must check every remaining candidate. Incomplete/failed reads pause selection.
  | { type: "select"; checkedBidders: { userId: number; eligible: boolean; payoutVersion: string }[] }
  | { type: "accept-offer"; person: Eligibility; acceptedPolicyHash: string }
  | { type: "decline-offer"; userId: number }
  | { type: "submit"; userId: number; generation: number; marker: string; prNumber: number; headSha: string }
  | { type: "request-withdraw"; userId: number; generation: number }
  // Worker only, after reading the chain: the exclusive binding definitely did not happen.
  | { type: "binding-failed"; generation: number }
  | { type: "withdraw"; userId: number; generation: number }
  | { type: "expire" }
  | { type: "reopen-bidding"; ownerId: number }
  | { type: "authorize-payment"; generation: number; headSha: string; settlementId: string; verified: boolean }
  | { type: "payment-confirmed"; settlementId: string; leg: "developer" | "refund" }
  | { type: "pause" };
function assign(m: Market, person: Eligibility, rewardCents: number, now: number) {
  assert(!m.assignment, "Another developer already holds this assignment");
  m.generation++;
  m.assignment = {
    generation: m.generation, userId: person.userId, login: person.login, rewardCents,
    payoutVersion: person.payoutVersion, acceptedAt: now, deadline: now + m.terms.deliveryHours * HOUR,
    confirmedAt: null, withdrawRequestedAt: null,
    marker: `${m.code}-A${m.generation}`, submission: null,
  };
  m.offer = null;
  m.phase = "in-progress";
}
/** Returns a new value. A rejected command never mutates the stored input. */
export function transition(current: Market, command: Command, serverNow: number): Market {
  const now = time(serverNow), m = structuredClone(current);
  assert(m.phase !== "paused", "Bounty is paused for dispute review");
  switch (command.type) {
    case "fund":
      assert(m.phase === "unfunded", "Funding is already recorded");
      assert(command.confirmedCents === m.terms.budgetCents, "Record exactly the locked budget; account for surplus separately");
      m.fundedAt = now;
      m.phase = m.terms.kind === "auction" ? "bidding" : "available";
      m.biddingClosesAt = m.terms.kind === "auction" ? now + m.terms.biddingHours * HOUR : null;
      break;
    case "claim":
      assert(m.terms.kind === "fixed" && m.phase === "available", "This bounty is not available for a direct claim");
      eligible(m, command.person); policy(m, command.acceptedPolicyHash);
      assign(m, command.person, m.terms.budgetCents, now);
      break;
    case "confirm-assignment": {
      const a = m.assignment;
      assert(m.phase === "in-progress" && a && !a.submission && !a.confirmedAt, "No assignment awaiting confirmation");
      assert(a.generation === command.generation, "Assignment generation mismatch");
      // Chain block time may trail the server clock slightly; a start earlier than that would
      // shorten the developer's window, so only bounded skew is accepted.
      assert(command.acceptedAt >= a.acceptedAt - MARKET_CLOCK_SKEW_MS && command.acceptedAt <= now && command.deadline === command.acceptedAt + m.terms.deliveryHours * HOUR, "Invalid on-chain assignment clock");
      a.acceptedAt = command.acceptedAt; a.deadline = command.deadline; a.confirmedAt = now;
      break;
    }
    case "binding-failed": {
      // Not the developer's fault: the generation is returned (the chain never recorded it) and the
      // bounty reopens. The engine and chain generations stay aligned.
      const a = m.assignment;
      assert(m.phase === "in-progress" && a && !a.confirmedAt && a.generation === command.generation, "Only an unconfirmed assignment can be released after a failed binding");
      m.history.push({ generation: a.generation, userId: a.userId, reason: "binding-failed", at: now });
      m.assignment = null; m.generation = a.generation - 1; m.phase = m.terms.kind === "fixed" ? "available" : "bidding";
      break;
    }
    case "request-withdraw": {
      const a = m.assignment;
      assert(m.phase === "in-progress" && a?.confirmedAt && !a.submission, "Only a confirmed assignment without a submitted PR can be released");
      assert(a.userId === command.userId && a.generation === command.generation, "Only the assigned developer can release this claim");
      a.withdrawRequestedAt ??= now;
      break;
    }
    case "bid": {
      assert(m.phase === "bidding" && now < m.biddingClosesAt!, "Bidding has closed");
      eligible(m, command.person); policy(m, command.acceptedPolicyHash);
      int(command.amountCents, 1, m.terms.budgetCents, "bid amount");
      assert(/^[a-zA-Z0-9-]{8,80}$/.test(command.bidId), "Invalid bid identifier");
      assert(m.bids.length < 500 || m.bids.some(b => b.userId === command.person.userId), "Bid limit reached");
      const previous = m.bids.find(b => b.userId === command.person.userId);
      assert(!m.bids.some(b => b.id === command.bidId && b.userId !== command.person.userId), "Bid identifier is already used");
      // Editing resets priority; ties use first final offer received, then GitHub ID.
      const bid: Bid = { id: previous?.id ?? command.bidId, userId: command.person.userId, login: command.person.login, amountCents: command.amountCents, payoutVersion: command.person.payoutVersion, acceptedPolicyHash: command.acceptedPolicyHash, submittedAt: now, status: "active" };
      m.bids = m.bids.filter(b => b.userId !== bid.userId).concat(bid);
      break;
    }
    case "withdraw-bid": {
      assert(m.phase === "bidding" && now < m.biddingClosesAt!, "Bidding has closed");
      const b = m.bids.find(b => b.userId === command.userId && b.status === "active");
      assert(b, "No active bid"); b.status = "withdrawn";
      break;
    }
    case "select": {
      assert(m.terms.kind === "auction" && ["bidding", "offered"].includes(m.phase) && now >= m.biddingClosesAt!, "The auction is not ready to select a winner");
      if (m.offer) {
        assert(now >= m.offer.expiresAt, "The winner still has time to confirm");
        m.bids.find(b => b.id === m.offer!.bidId)!.status = "timed-out";
        m.offer = null;
      }
      const active = m.bids.filter(b => b.status === "active");
      assert(new Set(command.checkedBidders.map(b => b.userId)).size === command.checkedBidders.length, "Duplicate eligibility result");
      assert(active.every(b => command.checkedBidders.some(c => c.userId === b.userId)), "Eligibility checks are incomplete; retry selection");
      const candidates = active.filter(b => command.checkedBidders.some(c => c.userId === b.userId && c.eligible && c.payoutVersion === b.payoutVersion));
      candidates.sort((a,b) => a.amountCents - b.amountCents || a.submittedAt - b.submittedAt || a.userId - b.userId);
      for (const b of active) if (!candidates.includes(b)) b.status = "ineligible";
      const winner = candidates[0];
      if (winner) { winner.status = "offered"; m.offer = { bidId: winner.id, expiresAt: now + m.terms.confirmationHours * HOUR }; m.phase = "offered"; }
      else m.phase = "bidding"; // Closed, no eligible bids. Explicit owner action starts a new round.
      break;
    }
    case "accept-offer": {
      assert(m.phase === "offered" && m.offer && now < m.offer.expiresAt, "This offer has expired");
      const b = m.bids.find(b => b.id === m.offer!.bidId)!;
      assert(b.userId === command.person.userId, "This offer belongs to another developer");
      eligible(m, command.person); policy(m, command.acceptedPolicyHash);
      assert(b.payoutVersion === command.person.payoutVersion, "Payout details changed; this offer must be revalidated");
      b.status = "accepted"; assign(m, command.person, b.amountCents, now); break;
    }
    case "decline-offer": {
      assert(m.phase === "offered" && m.offer, "No outstanding offer");
      const b = m.bids.find(b => b.id === m.offer!.bidId)!;
      assert(b.userId === command.userId, "This offer belongs to another developer");
      b.status = "declined"; m.offer = null; m.phase = "bidding"; break;
    }
    case "submit": {
      const a = m.assignment;
      assert(a && ["in-progress", "in-review"].includes(m.phase), "No active assignment");
      assert(a.confirmedAt, "The assignment is still being confirmed; wait for the deadline to appear before submitting");
      assert(!a.withdrawRequestedAt, "This assignment is being released");
      assert(a.userId === command.userId && a.generation === command.generation && a.marker === command.marker, "This submission does not belong to the current assignment");
      int(command.prNumber, 1, Number.MAX_SAFE_INTEGER, "pull request number");
      assert(/^[a-f0-9]{40}$/.test(command.headSha), "Invalid verified GitHub commit");
      if (a.submission) {
        assert(a.submission.prNumber === command.prNumber, "This assignment is already linked to another PR");
        if (a.submission.headSha === command.headSha) break;
      }
      assert(now <= a.deadline, "The delivery deadline has passed");
      a.submission = { prNumber: command.prNumber, headSha: command.headSha, receivedAt: now };
      m.phase = "in-review"; break;
    }
    case "withdraw":
    case "expire": {
      const a = m.assignment;
      assert(m.phase === "in-progress" && a && !a.submission, "Submitted work cannot be reassigned automatically");
      assert(a.confirmedAt, "An unconfirmed assignment is reconciled, not expired or withdrawn");
      if (command.type === "withdraw") assert(a.userId === command.userId && a.generation === command.generation && a.withdrawRequestedAt, "Only the assigned developer can release this claim");
      else assert(now > a.deadline + MARKET_RELAY_GRACE_MS, "The delivery or verification relay window is still open");
      m.history.push({ generation: a.generation, userId: a.userId, reason: command.type === "expire" ? "expired" : "withdrawn", at: now });
      m.assignment = null;
      m.phase = m.terms.kind === "fixed" ? "available" : "bidding";
      // Do not give another developer an obsolete auction price or a shortened window.
      if (m.terms.kind === "auction") { m.round++; m.bids = []; m.offer = null; m.biddingClosesAt = now + m.terms.biddingHours * HOUR; }
      break;
    }
    case "reopen-bidding":
      assert(command.ownerId === m.ownerId, "Only the owner can reopen bidding");
      assert(m.terms.kind === "auction" && m.phase === "bidding" && now >= m.biddingClosesAt! && !m.offer, "Bidding cannot reopen yet");
      assert(!m.bids.some(b => b.status === "active"), "Select or invalidate the remaining bids first");
      m.round++; m.bids = []; m.biddingClosesAt = now + m.terms.biddingHours * HOUR; break;
    case "authorize-payment": {
      const a = m.assignment;
      assert(m.phase === "in-review" && a?.submission, "A timely submission is required");
      assert(a.generation === command.generation && a.submission.headSha === command.headSha && command.verified === true, "Verify the exact submitted commit and qualifying client merge before authorizing payment");
      assert(/^[a-zA-Z0-9-]{8,100}$/.test(command.settlementId), "Invalid settlement identifier");
      m.settlement = { id: command.settlementId, developerCents: a.rewardCents, refundCents: m.terms.budgetCents - a.rewardCents, developerProcessed: false, refundProcessed: a.rewardCents === m.terms.budgetCents };
      m.phase = "payment-processing"; break;
    }
    case "payment-confirmed":
      assert(m.phase === "payment-processing" || m.phase === "paid", "Payment has not been authorized");
      assert(m.settlement?.id === command.settlementId, "Settlement reference mismatch");
      if (command.leg === "developer") m.settlement.developerProcessed = true;
      else m.settlement.refundProcessed = true;
      if (m.settlement.developerProcessed && m.settlement.refundProcessed) m.phase = "paid";
      break;
    case "pause":
      assert(!["payment-processing", "paid"].includes(m.phase), "Authorized payments cannot be recalled");
      m.phase = "paused"; break;
    default: { const never: never = command; throw new Error(`Unknown command: ${never}`); }
  }
  m.revision++;
  return m;
}
/** Public projection. Sealed bids and payout versions never leak through list/detail APIs. */
export function marketView(m: Market, viewerId?: number) {
  const { bids, assignment, ...safe } = m;
  const { payoutVersion: _private, ...publicAssignment } = assignment ?? {};
  return {
    ...safe, assignment: assignment ? publicAssignment : null,
    bidCount: bids.filter(b => !["withdrawn"].includes(b.status)).length,
    bids: bids.filter(b => viewerId === m.ownerId || viewerId === b.userId).map(({ payoutVersion: _v, acceptedPolicyHash: _p, ...bid }) => bid),
  };
}
