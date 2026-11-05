// Locate the NEAR transaction that marked an escrow payout as processed, using only JSON-RPC reads.
// Used to backfill explorer links for payouts recorded before the relayer saved transaction hashes.
// Nothing here signs or sends a transaction.

export type Rpc = (method: string, params: unknown) => Promise<any>;

export function jsonRpc(urls: string, fetcher: typeof fetch = fetch): Rpc {
  const list = urls.split(",").map((u) => u.trim()).filter(Boolean);
  if (!list.length) throw new Error("No NEAR RPC URL configured");
  return async (method, params) => {
    let last: unknown;
    for (const url of list) {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const response = await fetcher(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: "np", method, params }),
            signal: AbortSignal.timeout(15000),
          });
          if (response.status === 429) throw new Error("NEAR RPC rate limited");
          const body = (await response.json()) as { result?: unknown; error?: { name?: string; cause?: { name?: string }; message?: string } };
          if (body.error) {
            const name = body.error.cause?.name ?? body.error.name ?? "RPC_ERROR";
            // A missing or skipped block is an answer, not a transient failure.
            if (/UNKNOWN_BLOCK|UNKNOWN_CHUNK|GARBAGE_COLLECTED/.test(name)) throw Object.assign(new Error(name), { permanent: true });
            throw new Error(`${name}: ${body.error.message ?? ""}`);
          }
          return body.result;
        } catch (error) {
          if ((error as { permanent?: boolean }).permanent) throw error;
          last = error;
          await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        }
      }
    }
    throw last instanceof Error ? last : new Error("NEAR RPC unavailable");
  };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const EMPTY_ROOT = "11111111111111111111111111111111";

async function payoutStateAt(rpc: Rpc, contractId: string, payoutId: number, height: number) {
  const result = await rpc("query", { request_type: "call_function", block_id: height, account_id: contractId, method_name: "get_payout", args_base64: b64({ payout_id: payoutId }) });
  const payout = JSON.parse(Buffer.from(result.result).toString() || "null") as { state?: string } | null;
  return payout?.state ?? null;
}

/** Decode a FunctionCall action and check it is mark_payout_processed for this payout. */
function marksPayout(tx: any, contractId: string, relayerId: string, payoutId: number) {
  if (tx?.signer_id !== relayerId || tx?.receiver_id !== contractId) return false;
  return (tx.actions ?? []).some((action: any) => {
    const call = action?.FunctionCall;
    if (call?.method_name !== "mark_payout_processed") return false;
    try {
      return JSON.parse(Buffer.from(call.args, "base64").toString()).payout_id === payoutId;
    } catch {
      return false;
    }
  });
}

/** Confirm a hash is the successful mark_payout_processed call for this payout. */
export async function verifyPayoutTx(rpc: Rpc, hash: string, opts: { contractId: string; relayerId: string; payoutId: number }) {
  const outcome = await rpc("tx", { tx_hash: hash, sender_account_id: opts.relayerId, wait_until: "FINAL" });
  const success = outcome?.status && typeof outcome.status === "object" && "SuccessValue" in outcome.status;
  return Boolean(success && marksPayout(outcome.transaction, opts.contractId, opts.relayerId, opts.payoutId));
}

/**
 * Find the transaction hash. Binary-searches the first block where the payout reads "Processed",
 * then scans the blocks just before it for the relayer's call. Returns null when it cannot be proven.
 */
export async function findPayoutTx(rpc: Rpc, opts: { contractId: string; relayerId: string; payoutId: number; scanBack?: number }) {
  const { contractId, relayerId, payoutId } = opts;
  const head = (await rpc("block", { finality: "final" })).header.height as number;
  if ((await payoutStateAt(rpc, contractId, payoutId, head)) !== "Processed") return null;
  // Exponential search back to a block where the payout was not yet processed.
  let processed = head, step = 512, before = -1;
  while (before < 0) {
    const h = Math.max(1, processed - step);
    let state: string | null;
    try {
      state = await payoutStateAt(rpc, contractId, payoutId, h);
    } catch {
      state = null; // missing/garbage-collected block: treat as "before" and let the scan prove it
    }
    if (state === "Processed" && h > 1) { processed = h; step *= 2; }
    else before = h;
  }
  // Binary search for the first processed height (skipped heights fall back to the neighbour).
  while (processed - before > 1) {
    const mid = Math.floor((processed + before) / 2);
    let state: string | null;
    try {
      state = await payoutStateAt(rpc, contractId, payoutId, mid);
    } catch {
      state = null;
    }
    if (state === "Processed") processed = mid; else before = mid;
  }
  // The receipt executed at `processed`; the signed transaction was included at or shortly before it.
  for (let h = processed; h >= processed - (opts.scanBack ?? 8); h--) {
    let block: any;
    try {
      block = await rpc("block", { block_id: h });
    } catch {
      continue;
    }
    for (const chunk of block.chunks ?? []) {
      if (!chunk.tx_root || chunk.tx_root === EMPTY_ROOT) continue;
      const body = await rpc("chunk", { chunk_id: chunk.chunk_hash });
      const tx = (body.transactions ?? []).find((t: any) => marksPayout(t, contractId, relayerId, payoutId));
      if (tx && (await verifyPayoutTx(rpc, tx.hash, opts))) return tx.hash as string;
    }
  }
  return null;
}
