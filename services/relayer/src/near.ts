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
import type { JobView } from "./logic.ts";

export interface Job extends JobView {
  escrow_evm_address: string;
  artisan_short_iban: string;
  client_short_iban: string | null;
  link: "None" | "Signing" | "Failed" | { Signed: string };
}

export interface Payout {
  job_id: number;
  amount_cents: number;
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

  config(): Promise<{ next_job_id: number; next_payout_id: number; relayer: string }> {
    return this.#view("get_config", {});
  }

  job(job_id: number): Promise<Job | null> {
    return this.#view("get_job", { job_id });
  }

  payout(payout_id: number): Promise<Payout | null> {
    return this.#view("get_payout", { payout_id });
  }

  recordDeposit(job_id: number, amount_cents: number, monerium_order_id: string) {
    return this.#call("record_deposit", { job_id, amount_cents, monerium_order_id });
  }

  recordExcess(job_id: number, amount_cents: number, monerium_order_id: string) {
    return this.#call("record_excess", { job_id, amount_cents, monerium_order_id });
  }

  markProcessed(payout_id: number, monerium_order_id: string): Promise<string> {
    return this.#call("mark_payout_processed", { payout_id, monerium_order_id });
  }
}
