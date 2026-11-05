import { randomUUID } from 'node:crypto';
import { MoneriumRequestError } from './monerium.ts';
// One relayer pass: link escrow addresses, report incoming SEPA, submit signed payouts,
// confirm processed payouts. Every step is idempotent, so passes can be repeated safely.
import { amountFromMessage, classifyIncoming, counterpart, eurToCents, payeeFor, shortIban } from "./logic.ts";
import type { Monerium } from "./monerium.ts";
import type { Escrow, Job } from "./near.ts";
import type { Store } from "./store.ts";

const OWNERSHIP_MESSAGE = "I hereby declare that I am the address owner.";
const TERMINAL = new Set(["Closed", "Cancelled"]);
// Payouts of jobs this relayer does not track (e.g. created by another tool), logged once.
const untracked = new Set<number>();
// Funded jobs only receive surplus transfers; their Monerium orders are re-checked less often.
const FUNDED_ORDER_CHECK_MS = 10 * 60_000;
const orderCheckedAt = new Map<number, number>();

type Log = (msg: string) => void;

export async function runPass(escrow: Escrow, monerium: Monerium, store: Store, log: Log, nowMs = Date.now()): Promise<void> {
  const cfg = await escrow.config();
  // Incremental scan: only jobs this relayer tracks and that are not terminal are read each pass.
  // Steps 1–3 ignore untracked jobs anyway, so skipping them cannot change any decision.
  const scan = (store.state.scan ??= { terminalJobs: [], donePayouts: [], payoutJobs: {} });
  const terminal = new Set(scan.terminalJobs);
  const jobs = new Map<number, Job>();
  for (const key of Object.keys(store.state.jobs)) {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || id >= cfg.next_job_id || terminal.has(id)) continue;
    const job = await escrow.job(id);
    if (!job) continue;
    jobs.set(id, job);
    if (TERMINAL.has(job.state)) {
      scan.terminalJobs.push(id);
      store.save();
    }
  }

  // 1. Link escrow addresses that the contract has signed for.
  for (const [id, job] of jobs) {
    const rec = store.state.jobs[id];
    if (!rec || rec.linked || typeof job.link !== "object") continue;
    const created = await monerium.linkAddress(job.escrow_evm_address, OWNERSHIP_MESSAGE, job.link.Signed);
    log(`job ${id}: escrow address ${job.escrow_evm_address} ${created ? "linked" : "already linked"} at Monerium`);
    if (rec.moveIbanHere) {
      await monerium.moveIban(job.escrow_evm_address);
      log(`job ${id}: IBAN moved to the escrow address (sandbox demo)`);
    }
    rec.linked = true;
    store.save();
  }

  // 2. Report incoming SEPA transfers (Monerium issue orders) as deposits or excess.
  for (const [id, job] of jobs) {
    if (TERMINAL.has(job.state) || !store.state.jobs[id]?.linked) continue;
    const funded = job.deposited_cents >= job.milestones.reduce((n, m) => n + m.amount_cents, 0);
    if (funded && nowMs - (orderCheckedAt.get(id) ?? 0) < FUNDED_ORDER_CHECK_MS) continue;
    orderCheckedAt.set(id, nowMs);
    const incoming = (await monerium.ordersFor(job.escrow_evm_address)).filter((o) => o.kind === "issue" && o.state === "processed");
    for (const order of incoming) {
      if (store.state.reportedOrders.includes(order.id)) continue;
      const cents = eurToCents(order.amount);
      const fresh = (await escrow.job(id))!;
      const decision = classifyIncoming(fresh, cents, nowMs);
      if (decision === "ignore") continue;
      if (decision === "deposit") await escrow.recordDeposit(id, cents, order.id);
      else await escrow.recordExcess(id, cents, order.id);
      store.state.reportedOrders.push(order.id);
      store.save();
      log(`job ${id}: ${order.amount} EUR received → recorded as ${decision} (${order.id})`);
    }
  }

  // 3. Submit signed payouts to Monerium; 4. confirm the processed ones on-chain.
  const done = new Set(scan.donePayouts);
  for (let pid = 0; pid < cfg.next_payout_id; pid++) {
    if (done.has(pid)) continue;
    const knownJob = scan.payoutJobs[pid];
    if (knownJob !== undefined && !store.state.jobs[knownJob]) continue; // untracked: never actionable here
    const payout = await escrow.payout(pid);
    if (!payout) continue;
    if (scan.payoutJobs[pid] === undefined) {
      scan.payoutJobs[pid] = payout.job_id;
      store.save();
    }
    if (payout.state === "Processed") {
      scan.donePayouts.push(pid);
      done.add(pid);
      store.save();
      continue;
    }
    if (payout.state !== "Signed" || !payout.signature) continue;
    const rec = store.state.jobs[payout.job_id];
    let job = jobs.get(payout.job_id);
    if (!job && rec) {
      job = (await escrow.job(payout.job_id)) ?? undefined;
      if (job) jobs.set(payout.job_id, job);
    }
    if (!job || !rec) {
      if (!untracked.has(pid)) log(`payout ${pid}: no local record for job ${payout.job_id}, skipped`);
      untracked.add(pid);
      continue;
    }
    let orderId = store.state.submitted[pid];
    if (!orderId) {
      store.state.pendingSubmissions ??= {};
      const pending = store.state.pendingSubmissions[pid];
      if (pending) {
        const matches = (await monerium.ordersFor(job.escrow_evm_address)).filter((o) => o.kind === "redeem" && o.memo === pending.memo);
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
      const payee = payeeFor(payout.short_iban, rec.artisan, rec.client);
      if (shortIban(payee.iban) !== payout.short_iban) throw new Error("IBAN binding check failed");
      const memo = `NearPortal job ${payout.job_id} payout ${pid}`;
      const requestId = randomUUID();
      store.state.pendingSubmissions![pid] = { memo, requestId, at: new Date().toISOString() };
      store.save();
      let order;
      try { order = await monerium.placeRedeem({
        id: requestId,
        address: job.escrow_evm_address,
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
      log(`payout ${pid}: order ${orderId} rejected by Monerium — ask the mediator to review`);
    }
  }
}
