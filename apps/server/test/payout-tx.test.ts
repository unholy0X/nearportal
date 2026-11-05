import test from "node:test";
import assert from "node:assert/strict";
import { findPayoutTx, type Rpc } from "../server/tasks/payout-tx.ts";

const contractId = "escrow.example.testnet", relayerId = "relayer.example.testnet";
const call = (signer: string, payoutId: number, hash: string) => ({
  hash, signer_id: signer, receiver_id: contractId,
  actions: [{ FunctionCall: { method_name: "mark_payout_processed", args: Buffer.from(JSON.stringify({ payout_id: payoutId, monerium_order_id: "order" })).toString("base64") } }],
});
/** A small simulated chain: payout 7 becomes Processed at height `flip`; its tx is in block flip-1. */
function chain({ flip = 5000, head = 9000, success = true } = {}): { rpc: Rpc; calls: () => number } {
  let n = 0;
  const txs: Record<number, any[]> = {
    [flip - 1]: [call("someone.testnet", 7, "WRONG_SIGNER"), call(relayerId, 6, "WRONG_PAYOUT"), call(relayerId, 7, "RIGHT_HASH")],
  };
  const rpc: Rpc = async (method, params: any) => {
    n++;
    if (method === "block" && params.finality) return { header: { height: head } };
    if (method === "query") {
      const state = params.block_id >= flip ? "Processed" : "Signed";
      return { result: [...Buffer.from(JSON.stringify({ state }))] };
    }
    if (method === "block") return { chunks: [{ chunk_hash: `c${params.block_id}`, tx_root: txs[params.block_id] ? "root" : "11111111111111111111111111111111" }] };
    if (method === "chunk") return { transactions: txs[Number(params.chunk_id.slice(1))] ?? [] };
    if (method === "tx") {
      const tx = Object.values(txs).flat().find((t) => t.hash === params.tx_hash);
      return { transaction: tx, status: success ? { SuccessValue: "" } : { Failure: {} } };
    }
    throw new Error("unexpected " + method);
  };
  return { rpc, calls: () => n };
}

test("finds the relayer's mark_payout_processed transaction for exactly this payout", async () => {
  const { rpc, calls } = chain();
  assert.equal(await findPayoutTx(rpc, { contractId, relayerId, payoutId: 7 }), "RIGHT_HASH");
  assert.ok(calls() < 60, `bounded RPC usage (${calls()} calls)`);
});

test("never returns a transaction that failed on chain", async () => {
  const { rpc } = chain({ success: false });
  assert.equal(await findPayoutTx(rpc, { contractId, relayerId, payoutId: 7 }), null);
});

test("returns nothing for a payout that is not processed", async () => {
  const { rpc } = chain({ flip: 99999 });
  assert.equal(await findPayoutTx(rpc, { contractId, relayerId, payoutId: 7 }), null);
});
