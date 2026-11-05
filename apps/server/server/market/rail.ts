// Payment-rail adapters for fixed-deadline bounties. The common lifecycle (server/market/fixed.ts)
// decides WHAT happens; an adapter only performs and reads the rail-specific escrow operations.
// Both adapters read the authoritative chain state before any write, and every write is
// generation-sequenced on the contract, so repeating one after an uncertain outcome is either a
// no-op or rejected: it can never bind twice or move money.
import type { Task } from "../tasks/domain.ts";
import { shortIban } from "../tasks/payout.ts";

export interface ChainAssignment {
  generation: number;
  developerId: number;
  policyHash: string;
  /** Authoritative delivery start and inclusive limit (chain block time, ms). */
  startedAtMs: number;
  /** `null` when the bounty has no delivery window. */
  deadlineMs: number | null;
  headSha: string | null;
  submittedAtMs: number | null;
}
export interface ChainMarket {
  /** Last generation the chain accepted (0 = never assigned). */
  generation: number;
  /** Delivery window fixed at creation (`null` = no deadline). */
  deliverySeconds: number | null;
  assignment: ChainAssignment | null;
  /** The bounty's single settlement is authorized on chain. */
  released: boolean;
}
export interface Chain {
  view<T>(method: string, args?: Record<string, unknown>): Promise<T>;
  call(signer: string, method: string, args: Record<string, unknown>, deposit?: `${number}`): Promise<unknown>;
}
export interface MarketRail {
  readonly rail: "bank" | "base-usdc";
  /** Authorize the single fixed payout for the exact timely submission. Idempotent on chain. */
  release(t: Task, evidenceHash: string): Promise<{ alreadyAuthorized: boolean }>;
  /** The bounty as the escrow holds it, or null before `create_bounty`. */
  read(t: Task): Promise<ChainMarket | null>;
  bind(t: Task, a: { generation: number; developerId: number; policyHash: string }): Promise<void>;
  recordSubmission(t: Task, s: { generation: number; policyHash: string; headSha: string; observedAtMs: number }): Promise<void>;
  expire(t: Task, generation: number): Promise<void>;
  withdraw(t: Task, generation: number): Promise<void>;
}

/** The assignment fields of `get_bounty` (both rails; u64 values are decimal strings). */
export interface RawAssignment { generation: number; developer_id: string; assignment_hash: string; recipient: string; assigned_at_ns: string; deadline_ns: string | null; head_sha: string | null; submitted_at_ns: string | null }
const msFromNs = (ns: string) => Math.floor(Number(BigInt(ns) / 1_000_000n));
const nsFromMs = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
/** Delivery window of a deadline bounty, in seconds; `null` for a bounty without one. */
export const deliverySeconds = (t: Task): number | null => {
  const hours = t.policy.market?.deliveryHours ?? t.fundingPolicy?.market?.deliveryHours;
  return hours ? hours * 3600 : null;
};
function toChain(raw: { generation: number; delivery_seconds: number | null; assignment: RawAssignment | null }, released: boolean): ChainMarket {
  const a = raw.assignment;
  return {
    generation: raw.generation,
    deliverySeconds: raw.delivery_seconds,
    released,
    assignment: a
      ? {
          generation: a.generation,
          developerId: Number(a.developer_id),
          policyHash: a.assignment_hash,
          startedAtMs: msFromNs(a.assigned_at_ns),
          deadlineMs: a.deadline_ns === null ? null : msFromNs(a.deadline_ns),
          headSha: a.head_sha,
          submittedAtMs: a.submitted_at_ns === null ? null : msFromNs(a.submitted_at_ns),
        }
      : null,
  };
}

/** Monerium/NEAR bank escrow (`contracts/escrow`). Bounty ids are the decimal `t.jobId`. */
export function bankMarketRail(chain: Chain, accounts: { verifier: (t: Task) => string; onBound?: (t: Task) => void; onCleared?: (t: Task) => void }): MarketRail {
  const id = (t: Task) => {
    if (t.jobId === null) throw new Error("Escrow has not been created yet");
    return String(t.jobId);
  };
  const bounty = (t: Task) => chain.view<{ generation: number; delivery_seconds: number | null; assignment: RawAssignment | null; settlement_payout_id: string | null } | null>("get_bounty", { bounty_id: id(t) });
  return {
    rail: "bank",
    async read(t) {
      if (t.jobId === null) return null;
      const raw = await bounty(t);
      return raw ? toChain(raw, raw.settlement_payout_id !== null) : null;
    },
    async bind(t, a) {
      if (!t.payout) throw new Error("Bank payout details are missing for this assignment");
      await chain.call(accounts.verifier(t), "assign_developer", { bounty_id: id(t), generation: a.generation, assignment_hash: a.policyHash, developer_id: String(a.developerId), recipient_short_iban: shortIban(t.payout.iban) });
      accounts.onBound?.(t);
    },
    async recordSubmission(t, s) {
      await chain.call(accounts.verifier(t), "record_submission", { bounty_id: id(t), generation: s.generation, assignment_hash: s.policyHash, head_sha: s.headSha, observed_at_ns: nsFromMs(s.observedAtMs) });
    },
    async expire(t, generation) {
      // Permissionless on chain; sent by the verifier key, which is scoped to these methods.
      await chain.call(accounts.verifier(t), "expire_assignment", { bounty_id: id(t), generation });
      accounts.onCleared?.(t);
    },
    async withdraw(t, generation) {
      await chain.call(accounts.verifier(t), "withdraw_assignment", { bounty_id: id(t), generation });
      accounts.onCleared?.(t);
    },
    async release(t, evidenceHash) {
      const current = await bounty(t);
      if (current?.settlement_payout_id !== null && current?.settlement_payout_id !== undefined) return { alreadyAuthorized: true };
      const s = t.marketSubmission, a = t.policy.assignment;
      if (!s || !a || s.generation !== a.generation) throw new Error("No timely submission for the current assignment");
      await chain.call(accounts.verifier(t), "settle_bounty", { bounty_id: id(t), generation: a.generation, assignment_hash: t.policyHash, head_sha: s.headSha, evidence_hash: evidenceHash });
      return { alreadyAuthorized: false };
    },
  };
}

/** Base Sepolia USDC escrow (`contracts/usdc-escrow`). Bounty ids are the task UUID. */
export function cryptoMarketRail(chain: Chain, accounts: { verifier: string }): MarketRail {
  const bounty = (t: Task) => chain.view<{ generation: number; delivery_seconds: number | null; assignment: RawAssignment | null; payout: unknown } | null>("get_bounty", { bounty_id: t.id });
  return {
    rail: "base-usdc",
    async read(t) {
      const raw = await bounty(t);
      return raw ? toChain(raw, Boolean(raw.payout)) : null;
    },
    async bind(t, a) {
      if (t.policy.paymentRail !== "base-usdc" || !/^0x[0-9a-f]{40}$/.test(t.policy.recipient)) throw new Error("USDC payout address is missing for this assignment");
      await chain.call(accounts.verifier, "assign_developer", { bounty_id: t.id, generation: a.generation, assignment_hash: a.policyHash, developer_id: String(a.developerId), recipient_address: t.policy.recipient });
    },
    async recordSubmission(t, s) {
      await chain.call(accounts.verifier, "record_submission", { bounty_id: t.id, generation: s.generation, assignment_hash: s.policyHash, head_sha: s.headSha, observed_at_ns: nsFromMs(s.observedAtMs) });
    },
    async expire(t, generation) {
      await chain.call(accounts.verifier, "expire_assignment", { bounty_id: t.id, generation });
    },
    async withdraw(t, generation) {
      await chain.call(accounts.verifier, "withdraw_assignment", { bounty_id: t.id, generation });
    },
    /** Reconcile only: the USDC adapter sends `settle_bounty` itself, with the gas fee caps of the
     * single transaction it then broadcasts. */
    async release(t) {
      return { alreadyAuthorized: Boolean((await bounty(t))?.payout) };
    },
  };
}
