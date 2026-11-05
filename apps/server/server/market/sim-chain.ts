// Simulated escrow chain for simulation mode and isolated tests. It models the market methods of
// BOTH contracts (bank `market.rs`, USDC `crypto.rs` market extension) with the same rules:
// sequential generations, chain-time deadline, inclusive delivery limit, 15-minute relay grace,
// permissionless expiry without moving funds, release only for the exact timely head.
// State persists in SQLite so restart scenarios behave like a real chain. Never used in sandbox.
import type { DatabaseSync } from "node:sqlite";
import type { Chain } from "./rail.ts";

const GRACE_NS = 15n * 60n * 1_000_000_000n;
interface SimAssignment { generation: number; developer_id: number; reward_cents: number; policy_hash: string; deadline_ns: string; head_sha: string | null; submitted_at_ns: string | null }
interface SimMarket { funding_policy_hash: string; delivery_seconds: number; generation: number; assignment: SimAssignment | null; developer_payout_id: number | null; recipient: string | null; disputed: boolean }
export type Fault = { method: string; when: "before" | "after"; error?: string };

export class SimChain implements Chain {
  faults: Fault[] = [];
  calls: { method: string; args: Record<string, unknown> }[] = [];
  private payouts = 0;
  constructor(
    private readonly db: DatabaseSync,
    readonly options: { now: () => number; funded: (key: string) => boolean; escrowCents: (key: string) => number; verifier?: string },
  ) {
    db.exec("CREATE TABLE IF NOT EXISTS sim_market_chain(key TEXT PRIMARY KEY, body TEXT NOT NULL)");
    this.payouts = (db.prepare("SELECT COUNT(*) AS n FROM sim_market_chain WHERE json_extract(body,'$.developer_payout_id') IS NOT NULL").get() as { n: number }).n;
  }
  private load(key: string): SimMarket | null {
    const row = this.db.prepare("SELECT body FROM sim_market_chain WHERE key=?").get(key) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  private store(key: string, m: SimMarket) {
    this.db.prepare("INSERT INTO sim_market_chain VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(key, JSON.stringify(m));
  }
  private nowNs() {
    return BigInt(this.options.now()) * 1_000_000n;
  }
  private fault(method: string, when: "before" | "after") {
    const i = this.faults.findIndex((f) => f.method === method && f.when === when);
    if (i < 0) return;
    const [f] = this.faults.splice(i, 1);
    throw new Error(f!.error ?? (when === "after" ? "RPC timeout: transaction outcome unknown" : "RPC unavailable"));
  }
  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const key = String(args.job_id ?? args.id);
    if (method === "get_bounty_market" || method === "get_crypto_market") return this.load(key) as T;
    if (method === "get_crypto_bounty") {
      const m = this.load(key);
      return (m ? { payout: m.developer_payout_id !== null ? { id: m.developer_payout_id } : null } : null) as T;
    }
    throw new Error(`MethodResolveError(MethodNotFound): ${method}`);
  }
  async call(_signer: string, method: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, args });
    this.fault(method, "before");
    const result = this.apply(method, args);
    this.fault(method, "after");
    return result;
  }
  private apply(method: string, a: Record<string, unknown>): unknown {
    const key = String(a.job_id ?? a.id);
    const need = (ok: unknown, message: string) => {
      if (!ok) throw new Error(`Smart contract panicked: ${message}`);
    };
    const m = this.load(key);
    switch (method) {
      case "configure_bounty_market":
      case "configure_crypto_market": {
        need(!m, "Market already configured");
        need(Number(a.delivery_seconds) >= 3600 && Number(a.delivery_seconds) <= 90 * 86400, "Invalid delivery window");
        this.store(key, { funding_policy_hash: String(a.funding_policy_hash ?? a.funding_hash), delivery_seconds: Number(a.delivery_seconds), generation: 0, assignment: null, developer_payout_id: null, recipient: null, disputed: false });
        return null;
      }
      case "bind_market_assignment":
      case "bind_crypto_assignment": {
        need(m, method === "bind_market_assignment" ? "No bounty market" : "No crypto market");
        need(this.options.funded(key) && m!.developer_payout_id === null && !m!.disputed, method === "bind_market_assignment" ? "Uncommitted funded bounty required" : "Funded crypto bounty required");
        need(!m!.assignment, "Developer already bound");
        need(m!.generation + 1 === Number(a.generation), "Assignment generation mismatch");
        need(/^[a-f0-9]{64}$/.test(String(a.policy_hash)) && a.policy_hash !== m!.funding_policy_hash, "Invalid assignment hash");
        need(Number(a.developer_id) > 0, "Invalid developer identity");
        if (method === "bind_market_assignment") need(Number(a.reward_cents) === this.options.escrowCents(key), "Fixed reward cannot change");
        const deadline = this.nowNs() + BigInt(m!.delivery_seconds) * 1_000_000_000n;
        m!.generation = Number(a.generation);
        m!.recipient = String(a.recipient ?? a.recipient_short_iban);
        m!.assignment = { generation: m!.generation, developer_id: Number(a.developer_id), reward_cents: Number(a.reward_cents ?? this.options.escrowCents(key)), policy_hash: String(a.policy_hash), deadline_ns: deadline.toString(), head_sha: null, submitted_at_ns: null };
        this.store(key, m!);
        return null;
      }
      case "record_market_submission":
      case "record_crypto_submission": {
        need(m?.assignment, "No active assignment");
        const s = m!.assignment!;
        need(s.generation === Number(a.generation) && s.policy_hash === a.policy_hash, "Assignment mismatch");
        need(/^[a-f0-9]{40}$/.test(String(a.head_sha)), "Invalid GitHub commit");
        const observed = BigInt(String(a.observed_at_ns)), deadline = BigInt(s.deadline_ns);
        need(observed <= this.nowNs() && observed <= deadline, "Submission missed deadline");
        if (method === "record_market_submission") need(this.nowNs() <= deadline + GRACE_NS, "Submission relay grace expired");
        need(!s.submitted_at_ns || observed >= BigInt(s.submitted_at_ns), "Invalid submission observation time");
        s.head_sha = String(a.head_sha);
        s.submitted_at_ns = observed.toString();
        this.store(key, m!);
        return null;
      }
      case "expire_market_assignment":
      case "expire_crypto_assignment":
      case "withdraw_market_assignment":
      case "withdraw_crypto_assignment": {
        need(m?.assignment, "No active assignment");
        need(m!.assignment!.generation === Number(a.generation), "Assignment mismatch");
        if (method.startsWith("expire")) need(this.nowNs() > BigInt(m!.assignment!.deadline_ns) + GRACE_NS, "Delivery or relay window still open");
        need(!m!.assignment!.head_sha, "Submitted work cannot expire");
        need(m!.developer_payout_id === null && !m!.disputed, "Uncommitted funded bounty required");
        m!.assignment = null;
        m!.recipient = null;
        this.store(key, m!);
        return null;
      }
      case "release_market_assignment":
      case "release_crypto_market": {
        need(m?.assignment, "No active assignment");
        const s = m!.assignment!;
        need(s.generation === Number(a.generation) && s.policy_hash === a.policy_hash, "Assignment mismatch");
        need(s.head_sha === a.head_sha && s.submitted_at_ns, "Exact timely submission required");
        need(!m!.disputed, "Release paused");
        if (m!.developer_payout_id !== null) {
          need(method === "release_crypto_market", "Payment already authorized");
          return m!.developer_payout_id;
        }
        m!.developer_payout_id = ++this.payouts;
        this.store(key, m!);
        return m!.developer_payout_id;
      }
      case "dispute": {
        need(m && m.developer_payout_id === null, "Release already authorized");
        m!.disputed = true;
        this.store(key, m!);
        return null;
      }
      default:
        throw new Error(`MethodResolveError(MethodNotFound): ${method}`);
    }
  }
}
