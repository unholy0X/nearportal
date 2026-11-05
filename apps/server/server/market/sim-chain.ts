// Simulated NearPortal escrow contracts for simulation mode and isolated tests. One `SimChain`
// is one deployed contract: the bank rail (`contracts/escrow`) or the USDC rail
// (`contracts/usdc-escrow`). It implements the same methods, arguments, views, permissions,
// panic messages (`contracts/common/src/errors.rs`) and check order as the contracts:
// - roles: owner, relayer (time-locked rotation), a global verifier copied into each bounty and
//   frozen there, an operator allowlist; owner, verifier and operators are distinct accounts;
// - every bounty is open: generations 1, 2, ... through `assign_developer`, with or without a
//   delivery window; the deadline is inclusive, plus a 15-minute relay grace on both rails;
// - `settle_bounty` needs a recorded submission for the exact head; one settlement per bounty;
// - the refund destination is fixed at creation; the USDC rail signs one transaction only;
// - pause blocks create, deposit, assign, settle and resolve_dispute, nothing else.
// The MPC network is simulated by one deterministic secp256k1 key per derivation path, so the
// derived addresses, signatures and USDC transaction hashes are checked exactly as on chain;
// MPC callbacks complete within the same call. Gas is not modelled; storage costs a flat
// SIM_STORAGE_NEAR per created bounty.
// State persists in SQLite so restart scenarios behave like a real chain. Never used in sandbox.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { encodeFunctionData, erc20Abi, hashMessage, keccak256, parseTransaction, serializeTransaction, type Hex } from "viem";
import { privateKeyToAddress, sign } from "viem/accounts";
import type { Chain } from "./rail.ts";

/** `contracts/common/src/errors.rs` */
export const E = {
  ONLY_OWNER: "Only the owner",
  ONLY_RELAYER: "Only the relayer",
  ONLY_VERIFIER: "Only the verifier",
  ONLY_OPERATOR: "Only an operator",
  ONLY_CLIENT_OR_VERIFIER: "Only the client or the verifier",
  ONLY_CLIENT_OR_RELAYER: "Only the client or the relayer",
  ONLY_CLIENT_OWNER_OR_RELAYER: "Only the client, the owner or the relayer",
  ONLY_VERIFIER_OR_OWNER: "Only the verifier or the owner",
  OPERATOR_NOT_INDEPENDENT: "Operator must be independent",
  VERIFIER_NOT_INDEPENDENT: "Verifier must be independent",
  OWNER_NOT_INDEPENDENT: "Owner must be independent",
  PAUSED: "Contract is paused",
  TESTNET_ONLY: "Testnet only",
  RELAYER_TIME_LOCKED: "Relayer change is time-locked",
  NO_PENDING_RELAYER: "No pending relayer",
  NO_SUCH_BOUNTY: "No such bounty",
  NO_SUCH_PAYOUT: "No such payout",
  INVALID_BOUNTY_ID: "Invalid bounty id",
  INVALID_REWARD: "Invalid reward",
  INVALID_FUNDING_POLICY_HASH: "Invalid funding policy hash",
  INVALID_ASSIGNMENT_HASH: "Invalid assignment hash",
  INVALID_EVIDENCE_HASH: "Invalid evidence hash",
  INVALID_DELIVERY_WINDOW: "Invalid delivery window",
  INVALID_SHORT_IBAN: "Invalid short IBAN",
  INVALID_ESCROW_ADDRESS: "Invalid escrow EVM address",
  INVALID_REFUND_ADDRESS: "Invalid refund address",
  INVALID_RECIPIENT: "Invalid recipient",
  RECIPIENT_MATCHES_REFUND: "Recipient matches client refund",
  INVALID_DEVELOPER: "Invalid developer identity",
  INVALID_COMMIT: "Invalid GitHub commit",
  INVALID_ORDER_ID: "Invalid order id",
  INVALID_DEPOSIT_RECEIPT: "Invalid deposit receipt",
  INVALID_PROCESSED_RECEIPT: "Invalid processed receipt",
  AMOUNT_NOT_POSITIVE: "Amount must be positive",
  GAS_FEE_LIMIT: "Gas fee limit exceeded",
  BOUNTY_ALREADY_EXISTS: "Bounty already exists",
  ADDRESS_NOT_VERIFIED: "Escrow address not verified",
  ADDRESS_ALREADY_VERIFIED: "Escrow address already verified",
  LINK_NOT_AVAILABLE: "Escrow address not verified or bounty closed",
  LINK_ALREADY_REQUESTED: "Link signature already requested",
  FUNDED_UNSETTLED_REQUIRED: "Funded unsettled bounty required",
  NOTHING_TO_DISPUTE: "Nothing deposited to dispute",
  NO_OPEN_DISPUTE: "No open dispute",
  SETTLEMENT_ALREADY_AUTHORIZED: "Settlement already authorized",
  ORDER_ALREADY_RECORDED: "Order already recorded",
  RECEIPT_ALREADY_CONSUMED: "Receipt already consumed",
  DEVELOPER_ALREADY_BOUND: "Developer already bound",
  GENERATION_MISMATCH: "Assignment generation mismatch",
  ASSIGNMENT_HASH_MISMATCH: "Assignment hash mismatch",
  NO_ACTIVE_ASSIGNMENT: "No active assignment",
  SUBMISSION_MISSED_DEADLINE: "Submission missed deadline",
  RELAY_GRACE_EXPIRED: "Submission relay grace expired",
  INVALID_OBSERVATION_TIME: "Invalid submission observation time",
  NO_DEADLINE: "Assignment has no deadline",
  WINDOW_STILL_OPEN: "Delivery or relay window still open",
  SUBMITTED_WORK_CANNOT_EXPIRE: "Submitted work cannot expire",
  TIMELY_SUBMISSION_REQUIRED: "Exact timely submission required",
  PAYOUT_NOT_POSITIVE: "Payout must be positive",
  PAYOUT_EXCEEDS_UNCOMMITTED: "Payout exceeds uncommitted deposit",
  PAYOUT_CANNOT_BE_RESIGNED: "Payout cannot be signed again",
  PREVIOUS_MESSAGE_NOT_EXPIRED: "Previous message has not expired yet",
  MESSAGE_NOT_EXPIRED: "Message has not expired yet",
  PAYOUT_NOT_SIGNED: "Payout is not signed",
  PAYOUT_NOT_SIGNED_OR_FAILED: "Payout is not signed or failed",
  PAYOUT_NOT_SIGNING: "Payout is not signing",
  SIGNING_NOT_TIMED_OUT: "Signing has not timed out yet",
  SIGNATURE_RETRY_NOT_READY: "Signature retry not ready",
  PAYOUT_ALREADY_PROCESSED: "Payout already processed",
  INSUFFICIENT_STORAGE_DEPOSIT: "Insufficient storage deposit",
} as const;

const NS = 1_000_000_000n;
export const RELAY_GRACE_NS = 15n * 60n * NS;
const MIN_DELIVERY_SECONDS = 3_600;
const MAX_DELIVERY_SECONDS = 90 * 86_400;
export const MAX_REWARD_CENTS = 100_000n;
const RELAYER_CHANGE_DELAY_NS = 2n * 86_400n * NS;
const MESSAGE_LEAD_SECS = 600n;
const MONERIUM_TOLERANCE_SECS = 300n;
const MPC_TIMEOUT_SECS = 300n;
const SIGNATURE_RETRY_SECS = 900n;
const USDC_UNITS_PER_CENT = 10_000n;
const MAX_FEE_PER_GAS_WEI = 100_000_000_000n;
export const BASE_SEPOLIA_CHAIN_ID = 84_532;
export const USDC_CONTRACT_ADDRESS = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
export const OWNERSHIP_MESSAGE = "I hereby declare that I am the address owner.";
/** Flat storage price of one simulated bounty, in NEAR (callers attach 0.1 to 0.15). */
export const SIM_STORAGE_NEAR = 0.01;

export type SimRail = "bank" | "usdc";
export type Fault = { method: string; when: "before" | "after"; error?: string };
type U64 = string;
interface Assignment { generation: number; developer_id: U64; assignment_hash: string; recipient: string; assigned_at_ns: U64; deadline_ns: U64 | null; head_sha: string | null; submitted_at_ns: U64 | null }
interface Config { owner: string; relayer: string; pending_relayer: { relayer: string; not_before_ns: U64 } | null; verifier: string; operators: string[]; mpc_contract: string; mpc_path: string; paused: boolean; next_bounty_id: U64; next_payout_id: U64 }
export interface SimBankBounty { client: string; verifier: string; funding_policy_hash: string; reward_cents: U64; delivery_seconds: number | null; refund_short_iban: string; escrow_path: string; escrow_evm_address: string; state: "VerifyingAddress" | "AwaitingDeposit" | "Funded" | "Disputed" | "Closed" | "Cancelled"; link: "None" | "Signing" | "Failed" | { Signed: string }; created_at_ns: U64; deposited_cents: U64; committed_cents: U64; surplus_recorded_cents: U64; surplus_refunded_cents: U64; open_payouts: number; generation: number; assignment: Assignment | null; settlement_payout_id: U64 | null; settlement_evidence_hash: string | null }
interface BankPayout { bounty_id: U64; kind: "Developer" | "Refund" | "SurplusRefund"; amount_cents: U64; short_iban: string; message_unix_secs: U64; message: string; payload_hash: string; signature: string | null; state: "Signing" | "Signed" | "SignFailed" | "Processed"; failure_reason: string | null; resign_authorized: boolean; attempt: number; monerium_order_id: string | null }
interface UsdcPayout { kind: "Developer" | "Refund"; recipient: string; amount_units: U64; unsigned_tx: Hex; digest: string; evidence_hash: string | null; signature: string | null; signing: boolean; attempt: number; requested_at_secs: U64; tx_hash: string | null }
export interface SimUsdcBounty { client: string; verifier: string; funding_policy_hash: string; reward_cents: U64; delivery_seconds: number | null; refund_address: string; escrow_evm_address: string; state: "VerifyingAddress" | "AwaitingDeposit" | "Funded" | "Disputed" | "Closed" | "Cancelled"; deposited_units: U64; generation: number; assignment: Assignment | null; payout: UsdcPayout | null }
type Args = Record<string, unknown>;

function panic(message: string): never {
  throw new Error(`Smart contract panicked: ${message}`);
}
function need(ok: unknown, message: string): asserts ok {
  if (!ok) panic(message);
}
const isLowerHex = (s: string) => /^[0-9a-f]*$/.test(s);
const isSha256 = (s: unknown): s is string => typeof s === "string" && s.length === 64 && isLowerHex(s);
const isCommit = (s: unknown): s is string => typeof s === "string" && s.length === 40 && isLowerHex(s);
const isEvmAddress = (s: unknown): s is string => typeof s === "string" && s.length === 42 && s.startsWith("0x") && isLowerHex(s.slice(2)) && /[^0]/.test(s.slice(2));
const isShortIban = (s: unknown): s is string => typeof s === "string" && /^[A-Z]{2}[0-9]{2}\.\.\.[A-Z0-9]{4}$/.test(s);
const isRef = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 64;
const isUuid = (s: unknown): s is string => typeof s === "string" && s.length === 36 && /^[0-9a-fA-F-]+$/.test(s);
const isDepositReference = (s: unknown) => typeof s === "string" && /^84532:0x[0-9a-f]{64}:[0-9a-f]{8}$/.test(s);
/** A JSON `U64` is a decimal string; a JSON number is refused, as serde refuses it. */
function u64(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n)
    panic(`Failed to deserialize input from JSON.: ${name}: expected a decimal string`);
  return BigInt(value);
}
function u32(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff)
    panic(`Failed to deserialize input from JSON.: ${name}: expected u32`);
  return value as number;
}
function str(value: unknown, name: string): string {
  if (typeof value !== "string") panic(`Failed to deserialize input from JSON.: ${name}: expected a string`);
  return value;
}
function outcome(value: unknown): "Resume" | "Refund" {
  if (value !== "Resume" && value !== "Refund") panic("Failed to deserialize input from JSON.: outcome: unknown variant");
  return value;
}
function deliverySeconds(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const s = u32(value, "delivery_seconds");
  need(s >= MIN_DELIVERY_SECONDS && s <= MAX_DELIVERY_SECONDS, E.INVALID_DELIVERY_WINDOW);
  return s;
}
function formatEur(cents: bigint): string {
  const euros = cents / 100n, rest = cents % 100n;
  return rest === 0n ? euros.toString() : `${euros}.${rest.toString().padStart(2, "0")}`;
}
const rfc3339 = (secs: bigint) => new Date(Number(secs) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const redeemMessage = (cents: bigint, shortIban: string, secs: bigint) => `Send EUR ${formatEur(cents)} to ${shortIban} at ${rfc3339(secs)}`;
const add = (a: U64, b: bigint) => (BigInt(a) + b).toString();

export class SimChain implements Chain {
  faults: Fault[] = [];
  calls: { signer: string; method: string; args: Args }[] = [];
  readonly rail: SimRail;
  readonly contractId: string;
  readonly accounts: { owner: string; relayer: string; verifier: string; operator: string };
  constructor(
    private readonly db: DatabaseSync,
    readonly options: { now: () => number; rail?: SimRail; contractId?: string; owner?: string; relayer?: string; verifier?: string; operator?: string; mpcPath?: string },
  ) {
    this.rail = options.rail ?? "bank";
    this.contractId = options.contractId ?? (this.rail === "bank" ? "escrow.sim.testnet" : "usdc-escrow.sim.testnet");
    this.accounts = { owner: options.owner ?? "sim-owner", relayer: options.relayer ?? "sim-relayer", verifier: options.verifier ?? "sim-verifier", operator: options.operator ?? "sim-client" };
    db.exec("CREATE TABLE IF NOT EXISTS sim_escrow(contract TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(contract, kind, key))");
    if (!this.get("config", "")) {
      // `new(owner, relayer, verifier, mpc_contract, mpc_path)`, then the owner's `set_operator`.
      const { owner, relayer, verifier, operator } = this.accounts;
      need(owner !== verifier, E.VERIFIER_NOT_INDEPENDENT);
      need(operator !== owner && operator !== verifier, E.OPERATOR_NOT_INDEPENDENT);
      this.put("config", "", { owner, relayer, pending_relayer: null, verifier, operators: [operator], mpc_contract: "v1.signer-prod.testnet", mpc_path: options.mpcPath ?? (this.rail === "bank" ? "nearportal-bank-v1" : "nearportal-usdc-v1"), paused: false, next_bounty_id: "0", next_payout_id: "0" } satisfies Config);
    }
  }

  // ---------------- storage ----------------
  private get<T>(kind: string, key: string): T | null {
    const row = this.db.prepare("SELECT body FROM sim_escrow WHERE contract=? AND kind=? AND key=?").get(this.contractId, kind, key) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as T) : null;
  }
  private put(kind: string, key: string, value: unknown) {
    this.db.prepare("INSERT INTO sim_escrow VALUES(?,?,?,?) ON CONFLICT(contract,kind,key) DO UPDATE SET body=excluded.body").run(this.contractId, kind, key, JSON.stringify(value));
  }
  private config(): Config {
    return this.get<Config>("config", "")!;
  }
  private nowNs() {
    return BigInt(this.options.now()) * 1_000_000n;
  }
  private nowSecs() {
    return this.nowNs() / NS;
  }

  // ---------------- simulated MPC network ----------------
  private mpcKey(path: string): Hex {
    return `0x${createHash("sha256").update(`nearportal-sim-mpc:${this.contractId}:${path}`).digest("hex")}`;
  }
  /** Address the simulated MPC network derives for this contract and path (`derived_public_key`). */
  deriveAddress(path: string): string {
    return privateKeyToAddress(this.mpcKey(path)).toLowerCase();
  }
  /** `0x{r}{s}{v}` with v = 27 or 28, the format the contracts store. */
  private async mpcSign(path: string, digest: Hex): Promise<string> {
    const s = await sign({ hash: digest, privateKey: this.mpcKey(path) });
    return `0x${s.r.slice(2).padStart(64, "0")}${s.s.slice(2).padStart(64, "0")}${(Number(s.yParity) + 27).toString(16)}`;
  }
  private bankPath(id: string) {
    return `${this.config().mpc_path}/bounty-${id}`;
  }
  private usdcPath(id: string) {
    return `${this.config().mpc_path}/crypto/base-sepolia/usdc/${id}`;
  }

  // ---------------- Chain interface ----------------
  async view<T>(method: string, args: Args = {}): Promise<T> {
    const c = this.config();
    if (method === "get_config") {
      const { next_bounty_id, next_payout_id, ...shared } = c;
      return (this.rail === "bank"
        ? { ...shared, next_bounty_id, next_payout_id, max_reward_cents: MAX_REWARD_CENTS.toString() }
        : { ...shared, chain_id: String(BASE_SEPOLIA_CHAIN_ID), token: USDC_CONTRACT_ADDRESS, max_reward_cents: MAX_REWARD_CENTS.toString() }) as T;
    }
    if (method === "get_bounty") return this.get<T>("bounty", this.idOf(args)) as T;
    if (method === "get_escrow_path") {
      if (this.rail === "bank") return this.bankPath(u64(args.bounty_id, "bounty_id").toString()) as T;
      need(isUuid(args.bounty_id), E.INVALID_BOUNTY_ID);
      return this.usdcPath(args.bounty_id) as T;
    }
    if (method === "get_payout" && this.rail === "bank") return this.get<T>("payout", u64(args.payout_id, "payout_id").toString()) as T;
    throw new Error(`MethodResolveError(MethodNotFound): ${method}`);
  }
  async call(signer: string, method: string, args: Args, deposit: `${number}` = "0"): Promise<unknown> {
    this.calls.push({ signer, method, args });
    this.fault(method, "before");
    const result = await this.apply(signer, method, args, Number(deposit));
    this.fault(method, "after");
    return result;
  }
  private fault(method: string, when: "before" | "after") {
    const i = this.faults.findIndex((f) => f.method === method && f.when === when);
    if (i < 0) return;
    const [f] = this.faults.splice(i, 1);
    throw new Error(f!.error ?? (when === "after" ? "RPC timeout: transaction outcome unknown" : "RPC unavailable"));
  }
  private idOf(args: Args): string {
    return this.rail === "bank" ? u64(args.bounty_id, "bounty_id").toString() : str(args.bounty_id, "bounty_id");
  }
  private apply(caller: string, method: string, a: Args, deposit: number): Promise<unknown> | unknown {
    if (this.roles(caller, method, a)) return null;
    return this.rail === "bank" ? this.bank(caller, method, a, deposit) : this.usdc(caller, method, a, deposit);
  }

  /** Owner role management, identical on both rails (`contracts/common/src/roles.rs`). */
  private roles(caller: string, method: string, a: Args): boolean {
    const c = this.config();
    const owner = () => need(caller === c.owner, E.ONLY_OWNER);
    switch (method) {
      case "propose_relayer":
        owner();
        c.pending_relayer = { relayer: str(a.relayer, "relayer"), not_before_ns: (this.nowNs() + RELAYER_CHANGE_DELAY_NS).toString() };
        break;
      case "apply_relayer": {
        owner();
        const pending = c.pending_relayer;
        need(pending, E.NO_PENDING_RELAYER);
        need(this.nowNs() >= BigInt(pending.not_before_ns), E.RELAYER_TIME_LOCKED);
        c.relayer = pending.relayer;
        c.pending_relayer = null;
        break;
      }
      case "cancel_relayer_change":
        owner();
        c.pending_relayer = null;
        break;
      case "set_paused":
        owner();
        c.paused = a.paused === true;
        break;
      case "transfer_ownership": {
        owner();
        const next = str(a.new_owner, "new_owner");
        need(next !== c.verifier && !c.operators.includes(next), E.OWNER_NOT_INDEPENDENT);
        c.owner = next;
        break;
      }
      case "set_verifier": {
        owner();
        const next = str(a.verifier, "verifier");
        need(next !== c.owner && !c.operators.includes(next), E.VERIFIER_NOT_INDEPENDENT);
        c.verifier = next;
        break;
      }
      case "set_operator": {
        owner();
        const operator = str(a.operator, "operator");
        if (a.allowed === true) {
          need(operator !== c.owner && operator !== c.verifier, E.OPERATOR_NOT_INDEPENDENT);
          if (!c.operators.includes(operator)) c.operators.push(operator);
        } else c.operators = c.operators.filter((o) => o !== operator);
        break;
      }
      default:
        return false;
    }
    this.put("config", "", c);
    return true;
  }

  private notPaused() {
    need(!this.config().paused, E.PAUSED);
  }
  private assertOperator(caller: string) {
    need(this.config().operators.includes(caller), E.ONLY_OPERATOR);
  }
  private chargeStorage(deposit: number) {
    need(deposit >= SIM_STORAGE_NEAR, E.INSUFFICIENT_STORAGE_DEPOSIT);
  }

  // ---------------- assignments (`contracts/common/src/assignment.rs`) ----------------
  private newAssignment(generation: number, developerId: bigint, assignmentHash: string, recipient: string, delivery: number | null): Assignment {
    const now = this.nowNs();
    return { generation, developer_id: developerId.toString(), assignment_hash: assignmentHash, recipient, assigned_at_ns: now.toString(), deadline_ns: delivery === null ? null : (now + BigInt(delivery) * NS).toString(), head_sha: null, submitted_at_ns: null };
  }
  private requireMatches(asg: Assignment, generation: number, assignmentHash: unknown) {
    need(asg.generation === generation, E.GENERATION_MISMATCH);
    need(asg.assignment_hash === assignmentHash, E.ASSIGNMENT_HASH_MISMATCH);
  }
  private recordSubmission(asg: Assignment, headSha: string, observed: bigint) {
    const now = this.nowNs();
    need(isCommit(headSha), E.INVALID_COMMIT);
    need(observed <= now, E.INVALID_OBSERVATION_TIME);
    if (asg.deadline_ns !== null) {
      need(observed <= BigInt(asg.deadline_ns), E.SUBMISSION_MISSED_DEADLINE);
      need(now <= BigInt(asg.deadline_ns) + RELAY_GRACE_NS, E.RELAY_GRACE_EXPIRED);
    }
    need(observed >= BigInt(asg.assigned_at_ns) && (asg.submitted_at_ns === null || observed >= BigInt(asg.submitted_at_ns)), E.INVALID_OBSERVATION_TIME);
    asg.head_sha = headSha;
    asg.submitted_at_ns = observed.toString();
  }
  private requireSubmitted(asg: Assignment, headSha: unknown) {
    need(asg.head_sha === headSha && asg.submitted_at_ns !== null, E.TIMELY_SUBMISSION_REQUIRED);
  }
  private requireExpirable(asg: Assignment) {
    need(asg.deadline_ns !== null, E.NO_DEADLINE);
    need(asg.head_sha === null, E.SUBMITTED_WORK_CANNOT_EXPIRE);
    need(this.nowNs() > BigInt(asg.deadline_ns) + RELAY_GRACE_NS, E.WINDOW_STILL_OPEN);
  }

  // ---------------- bank rail (`contracts/escrow`) ----------------
  private bankBounty(id: string): SimBankBounty {
    const b = this.get<SimBankBounty>("bounty", id);
    need(b, E.NO_SUCH_BOUNTY);
    return b;
  }
  private bankPayout(id: string): BankPayout {
    const p = this.get<BankPayout>("payout", id);
    need(p, E.NO_SUCH_PAYOUT);
    return p;
  }
  /** Funded, not settled, not disputed, no payout in flight. */
  private idleFunded(b: SimBankBounty) {
    return b.state === "Funded" && b.open_payouts === 0;
  }
  private async signBankPayout(id: string, p: BankPayout, b: SimBankBounty) {
    p.signature = await this.mpcSign(b.escrow_path, `0x${p.payload_hash}`);
    p.state = "Signed";
    this.put("payout", id, p);
  }
  private async schedulePayout(bountyId: string, b: SimBankBounty, kind: BankPayout["kind"], amount: bigint, shortIban: string, fromDeposits: boolean): Promise<string> {
    need(amount > 0n, E.PAYOUT_NOT_POSITIVE);
    if (fromDeposits) {
      need(amount <= BigInt(b.deposited_cents) - BigInt(b.committed_cents), E.PAYOUT_EXCEEDS_UNCOMMITTED);
      b.committed_cents = add(b.committed_cents, amount);
    }
    b.open_payouts += 1;
    const c = this.config();
    const id = c.next_payout_id;
    c.next_payout_id = add(id, 1n);
    this.put("config", "", c);
    const secs = this.nowSecs() + MESSAGE_LEAD_SECS;
    const message = redeemMessage(amount, shortIban, secs);
    const p: BankPayout = { bounty_id: bountyId, kind, amount_cents: amount.toString(), short_iban: shortIban, message_unix_secs: secs.toString(), message, payload_hash: hashMessage(message).slice(2), signature: null, state: "Signing", failure_reason: null, resign_authorized: false, attempt: 0, monerium_order_id: null };
    await this.signBankPayout(id, p, b);
    return id;
  }
  /** Refunds all unrefunded surplus once the reward is funded or settled and nothing is in flight. */
  private async surplusRefundIfDue(bountyId: string, b: SimBankBounty): Promise<string | null> {
    const available = BigInt(b.surplus_recorded_cents) - BigInt(b.surplus_refunded_cents);
    if (available === 0n || b.open_payouts > 0 || !["Funded", "Closed"].includes(b.state)) return null;
    b.surplus_refunded_cents = add(b.surplus_refunded_cents, available);
    return this.schedulePayout(bountyId, b, "SurplusRefund", available, b.refund_short_iban, false);
  }
  private async bank(caller: string, method: string, a: Args, deposit: number): Promise<unknown> {
    const c = this.config();
    const verifier = (b: SimBankBounty) => need(caller === b.verifier, E.ONLY_VERIFIER);
    switch (method) {
      case "create_bounty": {
        this.notPaused();
        this.assertOperator(caller);
        const nb = (a.bounty ?? {}) as Args;
        const reward = u64(nb.reward_cents, "reward_cents");
        need(reward > 0n && reward <= MAX_REWARD_CENTS, E.INVALID_REWARD);
        need(isSha256(nb.funding_policy_hash), E.INVALID_FUNDING_POLICY_HASH);
        const delivery = deliverySeconds(nb.delivery_seconds);
        need(isShortIban(nb.refund_short_iban), E.INVALID_SHORT_IBAN);
        need(isEvmAddress(nb.escrow_evm_address), E.INVALID_ESCROW_ADDRESS);
        const id = c.next_bounty_id;
        c.next_bounty_id = add(id, 1n);
        const path = this.bankPath(id);
        const b: SimBankBounty = { client: caller, verifier: c.verifier, funding_policy_hash: nb.funding_policy_hash, reward_cents: reward.toString(), delivery_seconds: delivery, refund_short_iban: nb.refund_short_iban, escrow_path: path, escrow_evm_address: nb.escrow_evm_address, state: "VerifyingAddress", link: "None", created_at_ns: this.nowNs().toString(), deposited_cents: "0", committed_cents: "0", surplus_recorded_cents: "0", surplus_refunded_cents: "0", open_payouts: 0, generation: 0, assignment: null, settlement_payout_id: null, settlement_evidence_hash: null };
        this.chargeStorage(deposit);
        // `on_escrow_address_checked`: a mismatch cancels the bounty.
        b.state = this.deriveAddress(path) === b.escrow_evm_address ? "AwaitingDeposit" : "Cancelled";
        this.put("config", "", c);
        this.put("bounty", id, b);
        return id;
      }
      case "retry_address_check": {
        const id = this.idOf(a), b = this.bankBounty(id);
        need(caller === b.client || caller === b.verifier, E.ONLY_CLIENT_OR_VERIFIER);
        need(b.state === "VerifyingAddress", E.ADDRESS_ALREADY_VERIFIED);
        b.state = this.deriveAddress(this.bankPath(id)) === b.escrow_evm_address ? "AwaitingDeposit" : "Cancelled";
        this.put("bounty", id, b);
        return null;
      }
      case "record_deposit": {
        this.notPaused();
        need(caller === c.relayer, E.ONLY_RELAYER);
        const amount = u64(a.amount_cents, "amount_cents");
        need(amount > 0n, E.AMOUNT_NOT_POSITIVE);
        const id = this.idOf(a);
        const b = this.bankBounty(id);
        need(b.state !== "VerifyingAddress" && b.state !== "Cancelled", E.ADDRESS_NOT_VERIFIED);
        const order = a.monerium_order_id;
        need(isRef(order), E.INVALID_ORDER_ID);
        need(!this.get("order", order), E.ORDER_ALREADY_RECORDED);
        this.put("order", order, id);
        const missing = BigInt(b.reward_cents) - BigInt(b.deposited_cents);
        const allocated = b.state === "AwaitingDeposit" ? (amount < missing ? amount : missing) : 0n;
        if (allocated > 0n) {
          b.deposited_cents = add(b.deposited_cents, allocated);
          if (b.deposited_cents === b.reward_cents) b.state = "Funded";
        }
        if (amount > allocated) b.surplus_recorded_cents = add(b.surplus_recorded_cents, amount - allocated);
        const refund = await this.surplusRefundIfDue(id, b);
        this.put("bounty", id, b);
        return refund;
      }
      case "link_escrow_address": {
        const id = this.idOf(a);
        const b = this.bankBounty(id);
        need(caller === b.client || caller === c.relayer, E.ONLY_CLIENT_OR_RELAYER);
        need(["AwaitingDeposit", "Funded", "Disputed"].includes(b.state), E.LINK_NOT_AVAILABLE);
        need(b.link !== "Signing", E.LINK_ALREADY_REQUESTED);
        b.link = { Signed: await this.mpcSign(b.escrow_path, hashMessage(OWNERSHIP_MESSAGE)) };
        this.put("bounty", id, b);
        return null;
      }
      case "assign_developer": {
        this.notPaused();
        const id = this.idOf(a);
        const b = this.bankBounty(id);
        verifier(b);
        need(this.idleFunded(b), E.FUNDED_UNSETTLED_REQUIRED);
        need(!b.assignment, E.DEVELOPER_ALREADY_BOUND);
        const generation = u32(a.generation, "generation");
        need(b.generation + 1 === generation, E.GENERATION_MISMATCH);
        need(isSha256(a.assignment_hash) && a.assignment_hash !== b.funding_policy_hash, E.INVALID_ASSIGNMENT_HASH);
        const developer = u64(a.developer_id, "developer_id");
        need(developer > 0n, E.INVALID_DEVELOPER);
        need(isShortIban(a.recipient_short_iban), E.INVALID_SHORT_IBAN);
        need(a.recipient_short_iban !== b.refund_short_iban, E.RECIPIENT_MATCHES_REFUND);
        b.assignment = this.newAssignment(generation, developer, a.assignment_hash, a.recipient_short_iban, b.delivery_seconds);
        b.generation = generation;
        this.put("bounty", id, b);
        return null;
      }
      case "record_submission": {
        const id = this.idOf(a);
        const b = this.bankBounty(id);
        verifier(b);
        need(b.state === "Funded", E.FUNDED_UNSETTLED_REQUIRED);
        need(b.assignment, E.NO_ACTIVE_ASSIGNMENT);
        this.requireMatches(b.assignment, u32(a.generation, "generation"), a.assignment_hash);
        this.recordSubmission(b.assignment, str(a.head_sha, "head_sha"), u64(a.observed_at_ns, "observed_at_ns"));
        this.put("bounty", id, b);
        return null;
      }
      case "expire_assignment":
      case "withdraw_assignment": {
        const id = this.idOf(a);
        const b = this.bankBounty(id);
        if (method === "withdraw_assignment") verifier(b);
        need(this.idleFunded(b), E.FUNDED_UNSETTLED_REQUIRED);
        need(b.assignment, E.NO_ACTIVE_ASSIGNMENT);
        need(b.assignment.generation === u32(a.generation, "generation"), E.GENERATION_MISMATCH);
        if (method === "expire_assignment") this.requireExpirable(b.assignment);
        else need(b.assignment.head_sha === null, E.SUBMITTED_WORK_CANNOT_EXPIRE);
        b.assignment = null;
        this.put("bounty", id, b);
        return null;
      }
      case "settle_bounty": {
        this.notPaused();
        const id = this.idOf(a);
        const b = this.bankBounty(id);
        verifier(b);
        need(b.settlement_payout_id === null, E.SETTLEMENT_ALREADY_AUTHORIZED);
        need(isSha256(a.evidence_hash), E.INVALID_EVIDENCE_HASH);
        need(this.idleFunded(b), E.FUNDED_UNSETTLED_REQUIRED);
        need(b.assignment, E.NO_ACTIVE_ASSIGNMENT);
        this.requireMatches(b.assignment, u32(a.generation, "generation"), a.assignment_hash);
        this.requireSubmitted(b.assignment, a.head_sha);
        const payout = await this.schedulePayout(id, b, "Developer", BigInt(b.reward_cents), b.assignment.recipient, true);
        b.settlement_payout_id = payout;
        b.settlement_evidence_hash = a.evidence_hash;
        b.state = "Closed";
        this.put("bounty", id, b);
        return payout;
      }
      case "open_dispute": {
        const id = this.idOf(a);
        const b = this.bankBounty(id);
        need(caller === b.client || caller === b.verifier, E.ONLY_CLIENT_OR_VERIFIER);
        need(b.state === "Funded" || (b.state === "AwaitingDeposit" && BigInt(b.deposited_cents) > 0n), E.NOTHING_TO_DISPUTE);
        b.state = "Disputed";
        this.put("bounty", id, b);
        return null;
      }
      case "resolve_dispute": {
        need(caller === c.owner, E.ONLY_OWNER);
        this.notPaused();
        const id = this.idOf(a);
        const b = this.bankBounty(id);
        need(b.state === "Disputed", E.NO_OPEN_DISPUTE);
        if (outcome(a.outcome) === "Resume") {
          b.state = BigInt(b.deposited_cents) >= BigInt(b.reward_cents) ? "Funded" : "AwaitingDeposit";
          this.put("bounty", id, b);
          return null;
        }
        const payout = await this.schedulePayout(id, b, "Refund", BigInt(b.deposited_cents) - BigInt(b.committed_cents), b.refund_short_iban, true);
        b.settlement_payout_id = payout;
        b.state = "Closed";
        this.put("bounty", id, b);
        return payout;
      }
      case "mark_payout_processed": {
        need(caller === c.relayer, E.ONLY_RELAYER);
        need(isRef(a.monerium_order_id), E.INVALID_ORDER_ID);
        const pid = u64(a.payout_id, "payout_id").toString();
        const p = this.bankPayout(pid);
        need(p.state === "Signed", E.PAYOUT_NOT_SIGNED);
        p.state = "Processed";
        p.monerium_order_id = a.monerium_order_id;
        const b = this.bankBounty(p.bounty_id);
        b.open_payouts -= 1;
        this.put("payout", pid, p);
        await this.surplusRefundIfDue(p.bounty_id, b);
        this.put("bounty", p.bounty_id, b);
        return null;
      }
      case "retry_payout": {
        const pid = u64(a.payout_id, "payout_id").toString();
        const p = this.bankPayout(pid);
        const b = this.bankBounty(p.bounty_id);
        need(caller === b.client || caller === c.owner || caller === c.relayer, E.ONLY_CLIENT_OWNER_OR_RELAYER);
        need(this.nowSecs() > BigInt(p.message_unix_secs) + MONERIUM_TOLERANCE_SECS, E.PREVIOUS_MESSAGE_NOT_EXPIRED);
        const noSignaturePossible = p.state === "SignFailed" && p.failure_reason === "mpc call failed";
        need((p.state === "SignFailed" || p.state === "Signed") && (noSignaturePossible || p.resign_authorized), E.PAYOUT_CANNOT_BE_RESIGNED);
        p.message_unix_secs = (this.nowSecs() + MESSAGE_LEAD_SECS).toString();
        p.message = redeemMessage(BigInt(p.amount_cents), p.short_iban, BigInt(p.message_unix_secs));
        p.payload_hash = hashMessage(p.message).slice(2);
        p.signature = null;
        p.failure_reason = null;
        p.resign_authorized = false;
        p.attempt += 1;
        p.state = "Signing";
        await this.signBankPayout(pid, p, b);
        return null;
      }
      case "authorize_resign": {
        need(caller === c.owner, E.ONLY_OWNER);
        const pid = u64(a.payout_id, "payout_id").toString();
        const p = this.bankPayout(pid);
        need(p.state === "Signed" || p.state === "SignFailed", E.PAYOUT_NOT_SIGNED_OR_FAILED);
        need(this.nowSecs() > BigInt(p.message_unix_secs) + MONERIUM_TOLERANCE_SECS, E.MESSAGE_NOT_EXPIRED);
        p.resign_authorized = true;
        this.put("payout", pid, p);
        return null;
      }
      case "mark_sign_failed": {
        need(caller === c.owner, E.ONLY_OWNER);
        const pid = u64(a.payout_id, "payout_id").toString();
        const p = this.bankPayout(pid);
        need(p.state === "Signing", E.PAYOUT_NOT_SIGNING);
        need(this.nowSecs() > BigInt(p.message_unix_secs) + MONERIUM_TOLERANCE_SECS + MPC_TIMEOUT_SECS, E.SIGNING_NOT_TIMED_OUT);
        p.state = "SignFailed";
        p.failure_reason = "timeout";
        this.put("payout", pid, p);
        return null;
      }
      default:
        throw new Error(`MethodResolveError(MethodNotFound): ${method}`);
    }
  }

  // ---------------- USDC rail (`contracts/usdc-escrow`) ----------------
  private usdcBounty(id: string): SimUsdcBounty {
    const b = this.get<SimUsdcBounty>("bounty", id);
    need(b, E.NO_SUCH_BOUNTY);
    return b;
  }
  /** Not the escrow address itself and not the token contract. */
  private payable(address: unknown, escrow: string): address is string {
    return isEvmAddress(address) && address !== escrow && address !== USDC_CONTRACT_ADDRESS;
  }
  private async signUsdcPayout(id: string, b: SimUsdcBounty) {
    const p = b.payout!;
    p.signature = await this.mpcSign(this.usdcPath(id), `0x${p.digest}`);
    p.signing = false;
  }
  /** Freezes the bounty's single transaction (nonce 0, fixed gas limit, capped fees) and closes it. */
  private authorizeUsdcPayout(b: SimUsdcBounty, kind: UsdcPayout["kind"], recipient: string, units: bigint, evidence: string | null, maxFee: bigint, priorityFee: bigint) {
    need(maxFee > 0n && maxFee <= MAX_FEE_PER_GAS_WEI && priorityFee <= maxFee, E.GAS_FEE_LIMIT);
    need(units > 0n, E.PAYOUT_NOT_POSITIVE);
    const unsigned = serializeTransaction({ type: "eip1559", chainId: BASE_SEPOLIA_CHAIN_ID, nonce: 0, maxPriorityFeePerGas: priorityFee, maxFeePerGas: maxFee, gas: 120_000n, to: USDC_CONTRACT_ADDRESS, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient as Hex, units] }) });
    b.payout = { kind, recipient, amount_units: units.toString(), unsigned_tx: unsigned, digest: keccak256(unsigned).slice(2), evidence_hash: evidence, signature: null, signing: true, attempt: 0, requested_at_secs: this.nowSecs().toString(), tx_hash: null };
    b.state = "Closed";
  }
  /** keccak256 of the broadcast transaction: the unsigned bytes with the `0x{r}{s}{v}` signature. */
  static signedTxHash(unsigned: Hex, signature: string): string | null {
    if (!/^0x[0-9a-f]{130}$/.test(signature)) return null;
    const v = Number.parseInt(signature.slice(-2), 16);
    if (v !== 27 && v !== 28) return null;
    return keccak256(serializeTransaction(parseTransaction(unsigned), { r: `0x${signature.slice(2, 66)}`, s: `0x${signature.slice(66, 130)}`, yParity: v - 27 }));
  }
  private async usdc(caller: string, method: string, a: Args, deposit: number): Promise<unknown> {
    const c = this.config();
    const verifier = (b: SimUsdcBounty) => need(caller === b.verifier, E.ONLY_VERIFIER);
    switch (method) {
      case "create_bounty": {
        this.notPaused();
        need(this.contractId.endsWith(".testnet"), E.TESTNET_ONLY);
        this.assertOperator(caller);
        const id = a.bounty_id;
        need(isUuid(id), E.INVALID_BOUNTY_ID);
        const nb = (a.bounty ?? {}) as Args;
        const reward = u64(nb.reward_cents, "reward_cents");
        need(reward > 0n && reward <= MAX_REWARD_CENTS, E.INVALID_REWARD);
        need(isSha256(nb.funding_policy_hash), E.INVALID_FUNDING_POLICY_HASH);
        const delivery = deliverySeconds(nb.delivery_seconds);
        need(isEvmAddress(nb.escrow_evm_address), E.INVALID_ESCROW_ADDRESS);
        need(this.payable(nb.refund_address, nb.escrow_evm_address), E.INVALID_REFUND_ADDRESS);
        const old = this.get<SimUsdcBounty>("bounty", id);
        if (old) {
          // Repeating the call with identical terms is a no-op.
          need(old.client === caller && old.verifier === c.verifier && old.funding_policy_hash === nb.funding_policy_hash && old.reward_cents === reward.toString() && old.delivery_seconds === delivery && old.refund_address === nb.refund_address && old.escrow_evm_address === nb.escrow_evm_address, E.BOUNTY_ALREADY_EXISTS);
          return null;
        }
        const b: SimUsdcBounty = { client: caller, verifier: c.verifier, funding_policy_hash: nb.funding_policy_hash, reward_cents: reward.toString(), delivery_seconds: delivery, refund_address: nb.refund_address, escrow_evm_address: nb.escrow_evm_address, state: "VerifyingAddress", deposited_units: "0", generation: 0, assignment: null, payout: null };
        this.chargeStorage(deposit);
        // MPC callback: a confirmed mismatch is terminal.
        b.state = this.deriveAddress(this.usdcPath(id)) === b.escrow_evm_address ? "AwaitingDeposit" : "Cancelled";
        this.put("bounty", id, b);
        return null;
      }
      case "retry_address_check": {
        const id = this.idOf(a);
        const b = this.usdcBounty(id);
        need(caller === b.client || caller === b.verifier, E.ONLY_CLIENT_OR_VERIFIER);
        need(b.state === "VerifyingAddress", E.ADDRESS_ALREADY_VERIFIED);
        b.state = this.deriveAddress(this.usdcPath(id)) === b.escrow_evm_address ? "AwaitingDeposit" : "Cancelled";
        this.put("bounty", id, b);
        return null;
      }
      case "record_deposit": {
        this.notPaused();
        need(caller === c.relayer, E.ONLY_RELAYER);
        const id = this.idOf(a);
        const b = this.usdcBounty(id);
        need(b.state !== "VerifyingAddress" && b.state !== "Cancelled", E.ADDRESS_NOT_VERIFIED);
        const units = u64(a.units, "units");
        need(units > 0n && isDepositReference(a.reference), E.INVALID_DEPOSIT_RECEIPT);
        const reference = a.reference as string;
        const receipt = { bounty_id: id, units: units.toString() };
        const old = this.get<typeof receipt>("receipt", reference);
        if (old) {
          need(old.bounty_id === receipt.bounty_id && old.units === receipt.units, E.RECEIPT_ALREADY_CONSUMED);
          return null;
        }
        b.deposited_units = add(b.deposited_units, units);
        if (b.state === "AwaitingDeposit" && BigInt(b.deposited_units) >= BigInt(b.reward_cents) * USDC_UNITS_PER_CENT) b.state = "Funded";
        this.put("receipt", reference, receipt);
        this.put("bounty", id, b);
        return null;
      }
      case "assign_developer": {
        this.notPaused();
        const id = this.idOf(a);
        const b = this.usdcBounty(id);
        verifier(b);
        need(b.state === "Funded", E.FUNDED_UNSETTLED_REQUIRED);
        need(!b.assignment, E.DEVELOPER_ALREADY_BOUND);
        const generation = u32(a.generation, "generation");
        need(b.generation + 1 === generation, E.GENERATION_MISMATCH);
        need(isSha256(a.assignment_hash) && a.assignment_hash !== b.funding_policy_hash, E.INVALID_ASSIGNMENT_HASH);
        const developer = u64(a.developer_id, "developer_id");
        need(developer > 0n, E.INVALID_DEVELOPER);
        need(this.payable(a.recipient_address, b.escrow_evm_address), E.INVALID_RECIPIENT);
        need(a.recipient_address !== b.refund_address, E.RECIPIENT_MATCHES_REFUND);
        b.assignment = this.newAssignment(generation, developer, a.assignment_hash, a.recipient_address, b.delivery_seconds);
        b.generation = generation;
        this.put("bounty", id, b);
        return null;
      }
      case "record_submission": {
        const id = this.idOf(a);
        const b = this.usdcBounty(id);
        verifier(b);
        need(b.state === "Funded", E.FUNDED_UNSETTLED_REQUIRED);
        need(b.assignment, E.NO_ACTIVE_ASSIGNMENT);
        this.requireMatches(b.assignment, u32(a.generation, "generation"), a.assignment_hash);
        this.recordSubmission(b.assignment, str(a.head_sha, "head_sha"), u64(a.observed_at_ns, "observed_at_ns"));
        this.put("bounty", id, b);
        return null;
      }
      case "expire_assignment":
      case "withdraw_assignment": {
        const id = this.idOf(a);
        const b = this.usdcBounty(id);
        if (method === "withdraw_assignment") verifier(b);
        need(b.state === "Funded", E.FUNDED_UNSETTLED_REQUIRED);
        need(b.assignment, E.NO_ACTIVE_ASSIGNMENT);
        need(b.assignment.generation === u32(a.generation, "generation"), E.GENERATION_MISMATCH);
        if (method === "expire_assignment") this.requireExpirable(b.assignment);
        else need(b.assignment.head_sha === null, E.SUBMITTED_WORK_CANNOT_EXPIRE);
        b.assignment = null;
        this.put("bounty", id, b);
        return null;
      }
      case "settle_bounty": {
        this.notPaused();
        const id = this.idOf(a);
        const b = this.usdcBounty(id);
        verifier(b);
        if (b.payout) {
          // Repeating with the same evidence is a no-op; the signed bytes never change.
          need(b.payout.kind === "Developer" && b.payout.evidence_hash === a.evidence_hash, E.SETTLEMENT_ALREADY_AUTHORIZED);
          return null;
        }
        need(isSha256(a.evidence_hash), E.INVALID_EVIDENCE_HASH);
        need(b.state === "Funded", E.FUNDED_UNSETTLED_REQUIRED);
        need(b.assignment, E.NO_ACTIVE_ASSIGNMENT);
        this.requireMatches(b.assignment, u32(a.generation, "generation"), a.assignment_hash);
        this.requireSubmitted(b.assignment, a.head_sha);
        this.authorizeUsdcPayout(b, "Developer", b.assignment.recipient, BigInt(b.reward_cents) * USDC_UNITS_PER_CENT, a.evidence_hash, u64(a.max_fee, "max_fee"), u64(a.priority_fee, "priority_fee"));
        await this.signUsdcPayout(id, b);
        this.put("bounty", id, b);
        return null;
      }
      case "retry_payout_signature": {
        const id = this.idOf(a);
        const b = this.usdcBounty(id);
        need(caller === b.verifier || caller === c.owner, E.ONLY_VERIFIER_OR_OWNER);
        const p = b.payout;
        need(p, E.NO_SUCH_PAYOUT);
        need(p.signature === null && p.tx_hash === null && this.nowSecs() > BigInt(p.requested_at_secs) + SIGNATURE_RETRY_SECS, E.SIGNATURE_RETRY_NOT_READY);
        p.attempt += 1;
        p.signing = true;
        p.requested_at_secs = this.nowSecs().toString();
        await this.signUsdcPayout(id, b);
        this.put("bounty", id, b);
        return null;
      }
      case "mark_payout_processed": {
        need(caller === c.relayer, E.ONLY_RELAYER);
        const id = this.idOf(a);
        const b = this.usdcBounty(id);
        const p = b.payout;
        need(p, E.NO_SUCH_PAYOUT);
        need(p.signature, E.PAYOUT_NOT_SIGNED);
        need(SimChain.signedTxHash(p.unsigned_tx, p.signature) === a.tx_hash, E.INVALID_PROCESSED_RECEIPT);
        if (p.tx_hash) {
          need(p.tx_hash === a.tx_hash, E.PAYOUT_ALREADY_PROCESSED);
          return null;
        }
        p.tx_hash = a.tx_hash as string;
        this.put("bounty", id, b);
        return null;
      }
      case "open_dispute": {
        const id = this.idOf(a);
        const b = this.usdcBounty(id);
        need(caller === b.client || caller === b.verifier, E.ONLY_CLIENT_OR_VERIFIER);
        need(!b.payout, E.SETTLEMENT_ALREADY_AUTHORIZED);
        need(b.state === "Funded" || (b.state === "AwaitingDeposit" && BigInt(b.deposited_units) > 0n), E.NOTHING_TO_DISPUTE);
        b.state = "Disputed";
        this.put("bounty", id, b);
        return null;
      }
      case "resolve_dispute": {
        need(caller === c.owner, E.ONLY_OWNER);
        this.notPaused();
        const id = this.idOf(a);
        const b = this.usdcBounty(id);
        need(b.state === "Disputed", E.NO_OPEN_DISPUTE);
        if (outcome(a.outcome) === "Resume") {
          b.state = BigInt(b.deposited_units) >= BigInt(b.reward_cents) * USDC_UNITS_PER_CENT ? "Funded" : "AwaitingDeposit";
          this.put("bounty", id, b);
          return null;
        }
        this.authorizeUsdcPayout(b, "Refund", b.refund_address, BigInt(b.deposited_units), null, u64(a.max_fee, "max_fee"), u64(a.priority_fee, "priority_fee"));
        await this.signUsdcPayout(id, b);
        this.put("bounty", id, b);
        return null;
      }
      default:
        throw new Error(`MethodResolveError(MethodNotFound): ${method}`);
    }
  }
}

/** The two simulated contracts of one deployment, with the same role accounts. */
export function simEscrows(db: DatabaseSync, options: { now: () => number; verifier?: string; operator?: string; owner?: string; relayer?: string }) {
  return {
    bank: new SimChain(db, { ...options, rail: "bank" }),
    usdc: new SimChain(db, { ...options, rail: "usdc" }),
  };
}
export type SimEscrows = ReturnType<typeof simEscrows>;
