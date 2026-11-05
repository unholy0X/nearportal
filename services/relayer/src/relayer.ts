import { randomUUID } from 'node:crypto';
import { MoneriumRequestError } from './monerium.ts';
// One relayer pass: link escrow addresses, report incoming SEPA, submit signed payouts,
// confirm processed payouts. Every step is idempotent, so passes can be repeated safely.
import { acceptsDeposits, amountFromMessage, counterpart, eurToCents, payeeFor, shortIban } from "./logic.ts";
import type { Monerium } from "./monerium.ts";
import type { Bounty, Escrow } from "./near.ts";
import type { Store } from "./store.ts";

const OWNERSHIP_MESSAGE = "I hereby declare that I am the address owner.";
const TERMINAL = new Set(["Closed", "Cancelled"]);
// Payouts of bounties this relayer does not track (e.g. created by another tool), logged once.
const untracked = new Set<number>();
// Funded bounties only receive surplus transfers; their Monerium orders are re-checked less often.
const FUNDED_ORDER_CHECK_MS = 10 * 60_000;
const orderCheckedAt = new Map<number, number>();

type Log = (msg: string) => void;

export async function runPass(escrow: Escrow, monerium: Monerium, store: Store, log: Log, nowMs = Date.now()): Promise<void> {
  const cfg = await escrow.config();
  const nextBountyId = Number(cfg.next_bounty_id), nextPayoutId = Number(cfg.next_payout_id);
  // Incremental scan: only bounties this relayer tracks and that are not terminal are read each
  // pass. Steps 1–3 ignore untracked bounties anyway, so skipping them cannot change any decision.
  const scan = (store.state.scan ??= { terminalBounties: [], donePayouts: [], payoutBounties: {} });
  const terminal = new Set(scan.terminalBounties);
  const bounties = new Map<number, Bounty>();
  for (const key of Object.keys(store.state.bounties)) {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || id >= nextBountyId || terminal.has(id)) continue;
    const bounty = await escrow.bounty(id);
    if (!bounty) continue;
    bounties.set(id, bounty);
    if (TERMINAL.has(bounty.state)) {
      scan.terminalBounties.push(id);
      store.save();
    }
  }

  // 1. Link escrow addresses that the contract has signed for.
  for (const [id, bounty] of bounties) {
    const rec = store.state.bounties[id];
    if (!rec || rec.linked || typeof bounty.link !== "object") continue;
    const created = await monerium.linkAddress(bounty.escrow_evm_address, OWNERSHIP_MESSAGE, bounty.link.Signed);
    log(`bounty ${id}: escrow address ${bounty.escrow_evm_address} ${created ? "linked" : "already linked"} at Monerium`);
    if (rec.moveIbanHere) {
      await monerium.moveIban(bounty.escrow_evm_address);
      log(`bounty ${id}: IBAN moved to the escrow address (sandbox demo)`);
    }
    rec.linked = true;
    store.save();
  }

  // 2. Report every incoming SEPA transfer (Monerium issue order) with record_deposit. The
  // contract allocates it: the reward first, anything beyond it is surplus for the client.
  for (const [id, bounty] of bounties) {
    if (TERMINAL.has(bounty.state) || !store.state.bounties[id]?.linked) continue;
    const funded = bounty.deposited_cents === bounty.reward_cents;
    if (funded && nowMs - (orderCheckedAt.get(id) ?? 0) < FUNDED_ORDER_CHECK_MS) continue;
    orderCheckedAt.set(id, nowMs);
    const incoming = (await monerium.ordersFor(bounty.escrow_evm_address)).filter((o) => o.kind === "issue" && o.state === "processed");
    for (const order of incoming) {
      if (store.state.reportedOrders.includes(order.id)) continue;
      const cents = eurToCents(order.amount);
      const fresh = (await escrow.bounty(id))!;
      if (!acceptsDeposits(fresh.state)) continue;
      await escrow.recordDeposit(id, cents, order.id);
      store.state.reportedOrders.push(order.id);
      store.save();
      log(`bounty ${id}: ${order.amount} EUR received → recorded (${order.id})`);
    }
  }

  // 3. Submit signed payouts to Monerium; 4. confirm the processed ones on-chain.
  const done = new Set(scan.donePayouts);
  for (let pid = 0; pid < nextPayoutId; pid++) {
    if (done.has(pid)) continue;
    const knownBounty = scan.payoutBounties[pid];
    if (knownBounty !== undefined && !store.state.bounties[knownBounty]) continue; // untracked: never actionable here
    const payout = await escrow.payout(pid);
    if (!payout) continue;
    const bountyId = Number(payout.bounty_id);
    if (scan.payoutBounties[pid] === undefined) {
      scan.payoutBounties[pid] = bountyId;
      store.save();
    }
    if (payout.state === "Processed") {
      scan.donePayouts.push(pid);
      done.add(pid);
      store.save();
      continue;
    }
    if (payout.state !== "Signed" || !payout.signature) continue;
    const rec = store.state.bounties[bountyId];
    let bounty = bounties.get(bountyId);
    if (!bounty && rec) {
      bounty = (await escrow.bounty(bountyId)) ?? undefined;
      if (bounty) bounties.set(bountyId, bounty);
    }
    if (!bounty || !rec) {
      if (!untracked.has(pid)) log(`payout ${pid}: no local record for bounty ${bountyId}, skipped`);
      untracked.add(pid);
      continue;
    }
    let orderId = store.state.submitted[pid];
    if (!orderId) {
      store.state.pendingSubmissions ??= {};
      const pending = store.state.pendingSubmissions[pid];
      if (pending) {
        const matches = (await monerium.ordersFor(bounty.escrow_evm_address)).filter((o) => o.kind === "redeem" && o.memo === pending.memo);
        if (matches.length !== 1) {
          log(`payout ${pid}: redemption outcome uncertain; reconciliation/manual review required, not resubmitting`);
          continue;
        }
        orderId = matches[0]!.id;
        store.state.submitted[pid] = orderId;
        delete store.state.pendingSubmissions[pid];
        store.save();
      }
    }
    if (!orderId) {
      // The destinations fixed on chain: the assignment's recipient and the client refund IBAN.
      const onChain = payout.kind === "Developer" ? bounty.assignment?.recipient : bounty.refund_short_iban;
      if (onChain !== payout.short_iban) throw new Error(`payout ${pid}: destination differs from the bounty's on-chain recipient`);
      const payee = payeeFor(payout, rec);
      if (shortIban(payee.iban) !== payout.short_iban) throw new Error("IBAN binding check failed");
      const memo = `NearPortal bounty ${bountyId} payout ${pid}`;
      const requestId = randomUUID();
      store.state.pendingSubmissions![pid] = { memo, requestId, at: new Date().toISOString() };
      store.save();
      let order;
      try { order = await monerium.placeRedeem({
        id: requestId,
        address: bounty.escrow_evm_address,
        amount: amountFromMessage(payout.message),
        counterpart: counterpart(payee),
        message: payout.message,
        signature: payout.signature,
        memo,
      }); } catch (error) {
        store.state.pendingSubmissions![pid]!.error = error instanceof MoneriumRequestError ? `Monerium rejected this request (HTTP ${error.status}); review before retrying.` : 'Submission outcome uncertain; reconcile before retrying.';
        store.save();
        throw error;
      }
      orderId = order.id;
      store.state.submitted[pid] = orderId;
      delete store.state.pendingSubmissions![pid];
      store.save();
      log(`payout ${pid}: redeem order ${orderId} placed (${payout.message})`);
    }
    const order = await monerium.order(orderId);
    if (order.state === "processed") {
      const txHash = await escrow.markProcessed(pid, orderId);
      if (typeof txHash === "string" && txHash) {
        store.state.processedTx ??= {};
        store.state.processedTx[pid] = txHash;
        store.save();
      }
      log(`payout ${pid}: processed by Monerium, confirmed on-chain`);
    } else if (order.state === "rejected") {
      log(`payout ${pid}: order ${orderId} rejected by Monerium — ask the escrow owner to review`);
    }
  }
}
