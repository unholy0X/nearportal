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
  deadlineMs: number;
  headSha: string | null;
  submittedAtMs: number | null;
}
export interface ChainMarket {
  /** Last generation the chain accepted (0 = never bound). */
  generation: number;
  deliverySeconds: number;
  assignment: ChainAssignment | null;
  /** Settlement authorized on chain for the current assignment. */
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
  /** Record the deadline terms on the escrow (before acceptance/funding). Idempotent. */
  configure(t: Task): Promise<void>;
  read(t: Task): Promise<ChainMarket | null>;
  bind(t: Task, a: { generation: number; developerId: number; rewardCents: number; policyHash: string }): Promise<void>;
  recordSubmission(t: Task, s: { generation: number; policyHash: string; headSha: string; observedAtMs: number }): Promise<void>;
  expire(t: Task, generation: number): Promise<void>;
  withdraw(t: Task, generation: number): Promise<void>;
}

const msFromNs = (ns: string | number) => Math.floor(Number(BigInt(String(ns)) / 1_000_000n));
const nsFromMs = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const deliverySeconds = (t: Task) => {
  const hours = t.policy.market?.deliveryHours ?? t.fundingPolicy?.market?.deliveryHours;
  if (!hours) throw new Error("Not a fixed-deadline bounty");
  return hours * 3600;
};
function toChain(raw: { generation: number; delivery_seconds: number; assignment: null | { generation: number; developer_id: number; policy_hash: string; deadline_ns: string; head_sha: string | null; submitted_at_ns: string | null } }, released: boolean): ChainMarket {
  const a = raw.assignment;
  return {
    generation: raw.generation,
    deliverySeconds: raw.delivery_seconds,
    released,
    assignment: a
      ? {
          generation: a.generation,
          developerId: Number(a.developer_id),
          policyHash: a.policy_hash,
          deadlineMs: msFromNs(a.deadline_ns),
          startedAtMs: msFromNs((BigInt(a.deadline_ns) - BigInt(raw.delivery_seconds) * 1_000_000_000n).toString()),
          headSha: a.head_sha,
          submittedAtMs: a.submitted_at_ns ? msFromNs(a.submitted_at_ns) : null,
        }
      : null,
  };
}

/** Monerium/NEAR bank escrow: `contracts/escrow/src/market.rs`. */
export function bankMarketRail(chain: Chain, accounts: { client: string; verifier: (t: Task) => string; onBound?: (t: Task) => void; onCleared?: (t: Task) => void; jobOf?: (t: Task) => number | string | null }): MarketRail {
  const job = (t: Task) => {
    const id = accounts.jobOf ? accounts.jobOf(t) : t.jobId;
    if (id === null || id === undefined) throw new Error("Escrow has not been created yet");
    return id;
  };
  return {
    rail: "bank",
    async configure(t) {
      const existing = await chain.view<unknown>("get_bounty_market", { job_id: job(t) });
      if (existing) return;
      await chain.call(accounts.client, "configure_bounty_market", { job_id: job(t), funding_policy_hash: t.fundingPolicyHash, mode: "Fixed", delivery_seconds: deliverySeconds(t) });
    },
    async read(t) {
      if ((accounts.jobOf ? accounts.jobOf(t) : t.jobId) === null) return null;
      const raw = await chain.view<Parameters<typeof toChain>[0] & { developer_payout_id: number | null } | null>("get_bounty_market", { job_id: job(t) });
      return raw ? toChain(raw, raw.developer_payout_id !== null && raw.developer_payout_id !== undefined) : null;
    },
    async bind(t, a) {
      if (!t.payout) throw new Error("Bank payout details are missing for this assignment");
      await chain.call(accounts.verifier(t), "bind_market_assignment", { job_id: job(t), generation: a.generation, policy_hash: a.policyHash, developer_id: a.developerId, reward_cents: a.rewardCents, recipient_short_iban: shortIban(t.payout.iban) });
      accounts.onBound?.(t);
    },
    async recordSubmission(t, s) {
      await chain.call(accounts.verifier(t), "record_market_submission", { job_id: job(t), generation: s.generation, policy_hash: s.policyHash, head_sha: s.headSha, observed_at_ns: nsFromMs(s.observedAtMs) });
    },
    async expire(t, generation) {
      // Permissionless on chain; sent by the verifier key, which is scoped to these methods.
      await chain.call(accounts.verifier(t), "expire_market_assignment", { job_id: job(t), generation });
      accounts.onCleared?.(t);
    },
    async withdraw(t, generation) {
      await chain.call(accounts.verifier(t), "withdraw_market_assignment", { job_id: job(t), generation });
      accounts.onCleared?.(t);
    },
    async release(t, evidenceHash) {
      const current = await chain.view<{ developer_payout_id: number | null } | null>("get_bounty_market", { job_id: job(t) });
      if (current?.developer_payout_id !== null && current?.developer_payout_id !== undefined) return { alreadyAuthorized: true };
      const s = t.marketSubmission, a = t.policy.assignment;
      if (!s || !a || s.generation !== a.generation) throw new Error("No timely submission for the current assignment");
      await chain.call(accounts.verifier(t), "release_market_assignment", { job_id: job(t), generation: a.generation, policy_hash: t.policyHash, head_sha: s.headSha, evidence_hash: evidenceHash });
      return { alreadyAuthorized: false };
    },
  };
}

/** Base Sepolia USDC escrow: `crypto.rs` market extension (separate `crypto-market-v1` storage). */
export function cryptoMarketRail(chain: Chain, accounts: { client: string; verifier: string }): MarketRail {
  return {
    rail: "base-usdc",
    async configure(t) {
      const existing = await chain.view<unknown>("get_crypto_market", { id: t.id });
      if (existing) return;
      await chain.call(accounts.client, "configure_crypto_market", { id: t.id, funding_hash: t.fundingPolicyHash, delivery_seconds: deliverySeconds(t) });
    },
    async read(t) {
      const raw = await chain.view<Parameters<typeof toChain>[0] | null>("get_crypto_market", { id: t.id });
      if (!raw) return null;
      const bounty = await chain.view<{ payout: unknown } | null>("get_crypto_bounty", { id: t.id });
      return toChain(raw, Boolean(bounty?.payout));
    },
    async bind(t, a) {
      if (t.policy.paymentRail !== "base-usdc" || !/^0x[0-9a-f]{40}$/.test(t.policy.recipient)) throw new Error("USDC payout address is missing for this assignment");
      await chain.call(accounts.verifier, "bind_crypto_assignment", { id: t.id, generation: a.generation, policy_hash: a.policyHash, developer_id: a.developerId, recipient: t.policy.recipient });
    },
    async recordSubmission(t, s) {
      await chain.call(accounts.verifier, "record_crypto_submission", { id: t.id, generation: s.generation, policy_hash: s.policyHash, head_sha: s.headSha, observed_at_ns: nsFromMs(s.observedAtMs) });
    },
    async expire(t, generation) {
      await chain.call(accounts.verifier, "expire_crypto_assignment", { id: t.id, generation });
    },
    async withdraw(t, generation) {
      await chain.call(accounts.verifier, "withdraw_crypto_assignment", { id: t.id, generation });
    },
    /** USDC keeps `release_crypto_bounty` (frozen transfer); the extended contract requires the
     * market submission. Simulation uses the equivalent gate. */
    async release(t) {
      const bounty = await chain.view<{ payout: unknown } | null>("get_crypto_bounty", { id: t.id });
      return { alreadyAuthorized: Boolean(bounty?.payout) };
    },
  };
}
