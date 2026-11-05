import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { runPass } from "../src/relayer.ts";
import type { Escrow } from "../src/near.ts";
import type { Monerium } from "../src/monerium.ts";

test("an uncertain redemption is reconciled after restart without another submission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nearportal-relay-test-"));
  const file = join(dir, "state.json"); let store = new Store(file);
  // Monerium sandbox example IBAN; use one issued to your own Monerium sandbox account.
  store.state.bounties[0] = { developer: { iban: "FR7630006000011234567890189", country: "FR" }, client: { iban: "FR1420041010050500013M02606", country: "FR" }, linked: true };
  store.save();
  let submits = 0; let processed = 0; let discoverable = false;
  const escrow = {
    config: async () => ({ next_bounty_id: "1", next_payout_id: "1" }),
    bounty: async () => ({ state: "Closed", escrow_evm_address: "0x1234", refund_short_iban: "FR14...2606", assignment: { generation: 1, recipient: "FR76...0189" } }),
    payout: async () => ({ bounty_id: "0", kind: "Developer", state: "Signed", signature: "0xsigned", short_iban: "FR76...0189", message: "Send EUR 100.00 to FR76...0189 at 2026-11-03T12:00:00Z" }),
    markProcessed: async () => { processed++; return "Ep87YckjRdpUuve1QeKpEh6SbzSmEuKWfgeiDHxmWke3"; },
  } as unknown as Escrow;
  const order = { id: "redeem-1", kind: "redeem", memo: "NearPortal bounty 0 payout 0", state: "processed" };
  const monerium = {
    placeRedeem: async () => { submits++; throw new Error("Connection lost after remote acceptance"); },
    ordersFor: async () => discoverable ? [order] : [], order: async () => order,
  } as unknown as Monerium;
  try {
    await assert.rejects(runPass(escrow, monerium, store, () => {}), /Connection lost/);
    store = new Store(file);
    await runPass(escrow, monerium, store, () => {});
    assert.equal(submits, 1); assert.equal(processed, 0);
    discoverable = true;
    await runPass(escrow, monerium, store, () => {});
    assert.equal(submits, 1); assert.equal(processed, 1);
    assert.equal(new Store(file).state.processedTx?.["0"], "Ep87YckjRdpUuve1QeKpEh6SbzSmEuKWfgeiDHxmWke3", "explorer hash persisted with the processed payout");
    assert.equal(store.state.submitted[0], "redeem-1");
    assert.equal(store.state.pendingSubmissions?.[0], undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("passes are incremental: untracked bounties and processed payouts are not re-read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nearportal-relay-test-"));
  const store = new Store(join(dir, "state.json"));
  // Monerium sandbox example IBAN; use one issued to your own Monerium sandbox account.
  store.state.bounties[5] = { client: { iban: "FR1420041010050500013M02606", country: "FR" }, linked: true };
  const bountyReads: number[] = [], payoutReads: number[] = [];
  const escrow = {
    config: async () => ({ next_bounty_id: "50", next_payout_id: "40" }),
    bounty: async (id: number) => { bountyReads.push(id); return { state: "Funded", escrow_evm_address: "0xabc", deposited_cents: "100", reward_cents: "100", assignment: null }; },
    payout: async (id: number) => { payoutReads.push(id); return { bounty_id: id === 39 ? "5" : "1", state: "Processed", signature: null }; },
  } as unknown as Escrow;
  let orderReads = 0;
  const monerium = { ordersFor: async () => { orderReads++; return []; } } as unknown as Monerium;
  try {
    await runPass(escrow, monerium, store, () => {});
    assert.deepEqual(bountyReads, [5], "only the tracked bounty is read, not all 50");
    assert.equal(payoutReads.length, 40, "first pass indexes the payout history once");
    bountyReads.length = 0; payoutReads.length = 0;
    await runPass(escrow, monerium, store, () => {});
    assert.deepEqual(payoutReads, [], "processed and untracked payouts are not read again");
    assert.equal(orderReads, 1, "a funded bounty's Monerium orders are not polled on every pass");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("every Monerium issue order is reported through record_deposit with decimal-string ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nearportal-relay-test-"));
  const store = new Store(join(dir, "state.json"));
  // Monerium sandbox example IBAN; use one issued to your own Monerium sandbox account.
  store.state.bounties[2] = { client: { iban: "FR1420041010050500013M02606", country: "FR" }, linked: true };
  store.state.bounties[3] = { client: { iban: "FR1420041010050500013M02606", country: "FR" }, linked: true };
  const recorded: [number, number, string][] = [];
  const escrow = {
    config: async () => ({ next_bounty_id: "4", next_payout_id: "0" }),
    bounty: async (id: number) => id === 2
      ? { state: "AwaitingDeposit", escrow_evm_address: "0xa2", deposited_cents: "0", reward_cents: "5000", assignment: null }
      : { state: "VerifyingAddress", escrow_evm_address: "0xa3", deposited_cents: "0", reward_cents: "5000", assignment: null },
    recordDeposit: async (id: number, cents: number, order: string) => { recorded.push([id, cents, order]); return "tx"; },
  } as unknown as Escrow;
  const monerium = { ordersFor: async (address: string) => [
    { id: `${address}-1`, kind: "issue", state: "processed", amount: "30" },
    { id: `${address}-2`, kind: "issue", state: "processed", amount: "25.50" },
    { id: `${address}-3`, kind: "issue", state: "pending", amount: "1" },
  ] } as unknown as Monerium;
  try {
    await runPass(escrow, monerium, store, () => {});
    // The deposit beyond the reward is reported too: the contract records it as surplus.
    assert.deepEqual(recorded, [[2, 3000, "0xa2-1"], [2, 2550, "0xa2-2"]], "no unverified address, no pending order");
    await runPass(escrow, monerium, store, () => {});
    assert.equal(recorded.length, 2, "an order is reported once");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
