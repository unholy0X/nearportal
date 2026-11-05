// Thin wrapper around near-api-js for the escrow contract.
import { Account, FailoverRpcProvider, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";

/** Comma-separated RPC URLs, tried in order. Free endpoints rate-limit (HTTP 429), so each one
 * retries with backoff before the next takes over. */
export function rpcProvider(urls: string): FailoverRpcProvider {
  const list = urls.split(",").map((u) => u.trim()).filter(Boolean);
  if (list.length === 0) throw new Error("No NEAR RPC URL configured");
  return new FailoverRpcProvider(list.map((url) => new JsonRpcProvider({ url }, { retries: 4, wait: 800, backoff: 1.8 })));
}
import type { Config } from "./config.ts";
import type { BountyState } from "./logic.ts";

/** `get_bounty` of the bank-rail escrow (contracts/escrow). u64 values are decimal strings. */
export interface Bounty {
  state: BountyState;
  escrow_evm_address: string;
  /** Client refund destination, fixed at creation. */
  refund_short_iban: string;
  reward_cents: string;
  deposited_cents: string;
  /** The active developer assignment; `recipient` is its short IBAN. */
  assignment: { generation: number; recipient: string } | null;
  link: "None" | "Signing" | "Failed" | { Signed: string };
}

export type PayoutKind = "Developer" | "Refund" | "SurplusRefund";

export interface Payout {
  bounty_id: string;
  kind: PayoutKind;
  amount_cents: string;
  short_iban: string;
  message: string;
  signature: string | null;
  state: "Signing" | "Signed" | "SignFailed" | "Processed";
}

export class Escrow {
  readonly #provider: FailoverRpcProvider;
  readonly #account: Account;

  constructor(private readonly cfg: Config) {
    this.#provider = rpcProvider(cfg.nearRpc);
    this.#account = new Account(cfg.relayerAccountId, this.#provider, cfg.relayerPrivateKey as KeyPairString);
  }

  #view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    return this.#provider.callFunction({ contractId: this.cfg.contractId, method, args }) as Promise<T>;
  }

  /** Sends the call (failures throw as before) and returns the NEAR transaction hash. */
  async #call(methodName: string, args: Record<string, unknown>): Promise<string> {
    const outcome = await this.#account.callFunctionRaw({ contractId: this.cfg.contractId, methodName, args, gas: teraToGas("100") });
    return outcome.transaction.hash;
  }

  config(): Promise<{ next_bounty_id: string; next_payout_id: string; relayer: string }> {
    return this.#view("get_config", {});
  }

  bounty(bountyId: number): Promise<Bounty | null> {
    return this.#view("get_bounty", { bounty_id: String(bountyId) });
  }

  payout(payoutId: number): Promise<Payout | null> {
    return this.#view("get_payout", { payout_id: String(payoutId) });
  }

  /** The contract allocates the amount: the reward first, anything beyond it is surplus. */
  recordDeposit(bountyId: number, amountCents: number, moneriumOrderId: string) {
    return this.#call("record_deposit", { bounty_id: String(bountyId), amount_cents: String(amountCents), monerium_order_id: moneriumOrderId });
  }

  markProcessed(payoutId: number, moneriumOrderId: string): Promise<string> {
    return this.#call("mark_payout_processed", { payout_id: String(payoutId), monerium_order_id: moneriumOrderId });
  }
}
