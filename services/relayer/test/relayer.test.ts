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
  store.state.jobs[0] = { artisan: { iban: "FR7630006000011234567890189", country: "FR" }, client: { iban: "FR1430006000011234567896789", country: "FR" }, linked: true };
  store.save();
  let submits = 0; let processed = 0; let discoverable = false;
  const escrow = {
    config: async () => ({ next_job_id: 1, next_payout_id: 1 }),
    job: async () => ({ state: "Closed", escrow_evm_address: "0x1234" }),
    payout: async () => ({ job_id: 0, state: "Signed", signature: "0xsigned", short_iban: "FR76...0189", message: "Send EUR 100.00 to FR76...0189 at 2026-11-03T12:00:00Z" }),
    markProcessed: async () => { processed++; return "Ep87YckjRdpUuve1QeKpEh6SbzSmEuKWfgeiDHxmWke3"; },
  } as unknown as Escrow;
  const order = { id: "redeem-1", kind: "redeem", memo: "NearPortal job 0 payout 0", state: "processed" };
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

test("passes are incremental: untracked jobs and processed payouts are not re-read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nearportal-relay-test-"));
  const store = new Store(join(dir, "state.json"));
  // Monerium sandbox example IBAN; use one issued to your own Monerium sandbox account.
  store.state.jobs[5] = { artisan: { iban: "FR7630006000011234567890189", country: "FR" }, client: { iban: "FR1430006000011234567896789", country: "FR" }, linked: true };
  const jobReads: number[] = [], payoutReads: number[] = [];
  const escrow = {
    config: async () => ({ next_job_id: 50, next_payout_id: 40 }),
    job: async (id: number) => { jobReads.push(id); return { state: "Funded", escrow_evm_address: "0xabc", deposited_cents: 100, milestones: [{ amount_cents: 100 }] }; },
    payout: async (id: number) => { payoutReads.push(id); return { job_id: id === 39 ? 5 : 1, state: "Processed", signature: null }; },
  } as unknown as Escrow;
  let orderReads = 0;
  const monerium = { ordersFor: async () => { orderReads++; return []; } } as unknown as Monerium;
  try {
    await runPass(escrow, monerium, store, () => {});
    assert.deepEqual(jobReads, [5], "only the tracked job is read, not all 50");
    assert.equal(payoutReads.length, 40, "first pass indexes the payout history once");
    jobReads.length = 0; payoutReads.length = 0;
    await runPass(escrow, monerium, store, () => {});
    assert.deepEqual(payoutReads, [], "processed and untracked payouts are not read again");
    assert.equal(orderReads, 1, "a funded job's Monerium orders are not polled on every pass");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
