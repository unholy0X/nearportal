// Contract calls for the demo accounts, and escrow address derivation via the MPC network.
import bs58 from "bs58";
import { Account, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { rpcProvider } from "../../../services/relayer/src/near.ts";
import { keccak256, toHex } from "viem";
import { env, keyFor } from "./env.ts";
import { gate, ProviderFailure } from "./ops/provider.ts";

// Every NEAR RPC read and write passes one process-wide gate: bounded concurrency, hourly budget,
// circuit breaker. Set NEAR_RPC to a dedicated endpoint for hosted use (comma-separated failover).
const rpc = gate("near-rpc", { concurrency: 6, hourlyBudget: 20_000, timeoutMs: 60_000 });
const transient = (e: unknown) => /429|rate.?limit|too many|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket|5\d\d|Server error|exceeded/i.test(String((e as Error)?.message ?? e));
const guarded = <T>(call: () => Promise<T>, options: { key?: string; op: string; enforceTimeout?: boolean }) =>
  rpc.run(async () => {
    try {
      return await call();
    } catch (e) {
      // Provider-side trouble feeds the circuit breaker; contract errors are definite answers.
      if (transient(e)) throw new ProviderFailure(`NEAR RPC unavailable: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
      throw e;
    }
  }, options);

const provider = rpcProvider(env.nearRpc);
const accounts = new Map<string, Account>();

function account(id: string): Account {
  let a = accounts.get(id);
  if (!a) {
    a = new Account(id, provider, keyFor(id) as KeyPairString);
    accounts.set(id, a);
  }
  return a;
}

// Free RPC endpoints rate-limit hard and every open page polls every few seconds: identical reads
// within a short window share one request.
const VIEW_TTL_MS = 5000;
const viewCache = new Map<string, { at: number; value: Promise<unknown> }>();

export function view<T>(method: string, args: Record<string, unknown> = {}, contractId = env.contractId): Promise<T> {
  const key = `${contractId}:${method}:${JSON.stringify(args)}`;
  const hit = viewCache.get(key);
  if (hit && Date.now() - hit.at < VIEW_TTL_MS) return hit.value as Promise<T>;
  const value = guarded(() => provider.callFunction({ contractId, method, args }) as Promise<unknown>, { key, op: "view" });
  viewCache.set(key, { at: Date.now(), value });
  value.catch(() => viewCache.delete(key));
  while (viewCache.size > 5000) viewCache.delete(viewCache.keys().next().value!);
  return value as Promise<T>;
}

/** Drops cached reads after a transaction so the next poll sees the new state: only for the
 * contract that changed when known, otherwise everything. */
export const invalidateViews = (contractId?: string) => {
  if (!contractId) return viewCache.clear();
  for (const k of [...viewCache.keys()]) if (k.startsWith(`${contractId}:`)) viewCache.delete(k);
};

// One transaction at a time per signer: parallel calls from the same key race on the nonce.
const queues = new Map<string, Promise<unknown>>();

export function call(signer: string, methodName: string, args: Record<string, unknown>, deposit: `${number}` = "0", contractId = env.contractId): Promise<unknown> {
  const previous = queues.get(signer) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => send(signer, methodName, args, deposit, false, contractId));
  queues.set(signer, run);
  return run;
}

async function send(signer: string, methodName: string, args: Record<string, unknown>, deposit: `${number}`, retried = false, contractId = env.contractId): Promise<unknown> {
  try {
    // Writes are admitted by the gate but never de-duplicated or retried by it.
    return await guarded(() => account(signer).callFunction({
      contractId,
      methodName,
      args,
      gas: teraToGas("300"),
      deposit: nearToYocto(deposit),
    }), { op: "call", enforceTimeout: false });
  } catch (e) {
    // A rate-limited RPC can make the failover resend a transaction that already went through, or
    // leave a stale nonce. Retry once with a fresh account, except create_job, which is not
    // idempotent; every other method refuses a repeated state change.
    if (!retried && !["create_job"].includes(methodName) && e instanceof Error && /nonce/i.test(e.message)) {
      accounts.delete(signer);
      await new Promise((r) => setTimeout(r, 1500));
      return send(signer, methodName, args, deposit, true, contractId);
    }
    throw e;
  } finally {
    invalidateViews(contractId);
  }
}

/** EVM address the MPC network derives for this contract and path. */
export async function deriveEscrowAddress(path: string, contractId = env.contractId): Promise<string> {
  const key = (await guarded(() => provider.callFunction({
    contractId: env.mpcContract,
    method: "derived_public_key",
    args: { path, predecessor: contractId, domain_id: 0 },
  }) as Promise<unknown>, { key: `mpc:${contractId}:${path}`, op: "view" })) as string;
  const raw = bs58.decode(key.split(":")[1]!);
  return `0x${keccak256(toHex(raw)).slice(-40)}`;
}
