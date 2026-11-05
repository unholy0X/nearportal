import { createHash } from "node:crypto";
import { CHAIN_ID, USDC } from "../crypto/evm.ts";
import { findPayoutTx, jsonRpc } from "./payout-tx.ts";
import { gate, ProviderFailure, retryAfterMs } from "../ops/provider.ts";
import { KeyedLock } from "../ops/locks.ts";
import { bankMarketRail, cryptoMarketRail, deliverySeconds, type MarketRail } from "../market/rail.ts";
import { SimChain, type SimEscrows, type SimBankBounty, type SimUsdcBounty } from "../market/sim-chain.ts";

// Shared sandbox rail state needs mutual exclusion across tasks: the escrow bounty-id reservation
// (read next_bounty_id, then create_bounty) and registration of the single movable deposit IBAN.
// Everything else runs per task in parallel.
const provisioning = new KeyedLock();
import { evaluateRelease } from "./release-policy.ts";
import { hash, note, type Task } from "./domain.ts";
import { payoutFor, shortIban } from "./payout.ts";
import type { TaskStore } from "./store.ts";

export interface PaymentAdapter {
  prepare(t: Task): Promise<void>;
  sync(t: Task): Promise<void>;
  release(t: Task): Promise<void>;
  dispute(t: Task, role: "client" | "developer"): Promise<void>;
  deposit(t: Task): Promise<{ iban: string | null; reference: string }>;
  /** Fixed-deadline escrow operations for this rail (absent: the rail does not support them). */
  market?(t: Task): MarketRail;
}

/** Fictional refund destinations of the simulated client (never a real account). */
export const SIM_REFUND_SHORT_IBAN = "DE89...3000";
export const SIM_REFUND_ADDRESS = "0x" + "c1ea2".repeat(8);
/** Simulated gas fee caps of the single USDC transaction (wei). */
const SIM_FEES = { max_fee: "2000000000", priority_fee: "1000000" };

/**
 * Simulation mode. Without escrows every payment is simulated in memory. With the simulated
 * escrow contracts (`sim-chain.ts`), every open bounty follows the same calls as the testnet
 * rails: create_bounty, record_deposit (when the simulated transfer arrives), assign_developer,
 * record_submission, settle_bounty and the relayer's mark_payout_processed. No funds move.
 */
export class SimulatedPayments implements PaymentAdapter {
  private rails?: { bank: MarketRail; usdc: MarketRail };
  constructor(private readonly store: TaskStore, private readonly escrows?: SimEscrows) {
    if (escrows) this.rails = {
      bank: bankMarketRail(escrows.bank, { verifier: (t) => t.policy.verifier }),
      usdc: cryptoMarketRail(escrows.usdc, { verifier: escrows.usdc.accounts.verifier }),
    };
  }
  market(t: Task): MarketRail {
    if (!this.rails) throw new Error("Deadline bounties need the simulated escrow chain");
    return t.policy.paymentRail === "base-usdc" ? this.rails.usdc : this.rails.bank;
  }
  private chain(t: Task): SimChain | null {
    if (!this.escrows || !t.openBounty) return null;
    return t.policy.paymentRail === "base-usdc" ? this.escrows.usdc : this.escrows.bank;
  }
  private async bounty(t: Task): Promise<SimBankBounty | SimUsdcBounty | null> {
    const chain = this.chain(t);
    if (!chain) return null;
    if (chain.rail === "bank") return t.jobId === null ? null : chain.view<SimBankBounty | null>("get_bounty", { bounty_id: String(t.jobId) });
    return chain.view<SimUsdcBounty | null>("get_bounty", { bounty_id: t.id });
  }
  private key(t: Task) {
    return this.chain(t)!.rail === "bank" ? { bounty_id: String(t.jobId) } : { bounty_id: t.id };
  }
  async prepare(t: Task): Promise<void> {
    const chain = this.chain(t);
    if (!chain || !t.clientAccepted) return;
    const funding = { funding_policy_hash: t.fundingPolicyHash ?? t.policyHash, reward_cents: String(t.policy.amountCents), delivery_seconds: deliverySeconds(t) };
    let b = await this.bounty(t);
    if (!b && chain.rail === "bank") {
      const id = (await chain.view<{ next_bounty_id: string }>("get_config")).next_bounty_id;
      const address = chain.deriveAddress(await chain.view<string>("get_escrow_path", { bounty_id: id }));
      t.jobId = Number(await chain.call(chain.accounts.operator, "create_bounty", { bounty: { ...funding, refund_short_iban: SIM_REFUND_SHORT_IBAN, escrow_evm_address: address } }, "0.15"));
      this.store.save(t);
      note(t, `Simulated escrow bounty ${t.jobId} created. No funds move.`);
    } else if (!b) {
      const address = chain.deriveAddress(await chain.view<string>("get_escrow_path", { bounty_id: t.id }));
      await chain.call(chain.accounts.operator, "create_bounty", { bounty_id: t.id, bounty: { ...funding, refund_address: t.policy.refundAddress ?? SIM_REFUND_ADDRESS, escrow_evm_address: address } }, "0.1");
      note(t, "Simulated USDC escrow created. No funds move.");
    }
    b = await this.bounty(t);
    if (!b || b.funding_policy_hash !== funding.funding_policy_hash || b.reward_cents !== funding.reward_cents || b.delivery_seconds !== funding.delivery_seconds || b.verifier !== t.policy.verifier)
      throw new Error("Simulated escrow does not match the funded agreement");
    // Bounties without a deadline are assigned here; deadline bounties by the common lifecycle.
    if (!t.policy.market && t.policy.developerId !== 0 && t.funded && b.state === "Funded") {
      if (!b.assignment)
        await chain.call(t.policy.verifier, "assign_developer", { ...this.key(t), generation: b.generation + 1, assignment_hash: t.policyHash, developer_id: String(t.policy.developerId), ...(chain.rail === "bank" ? { recipient_short_iban: shortIban(payoutFor(t).iban) } : { recipient_address: t.policy.recipient }) });
      else if (b.assignment.assignment_hash !== t.policyHash) throw new Error("On-chain assignment does not match this task");
    }
  }
  async sync(t: Task): Promise<void> {
    const chain = this.chain(t);
    if (!chain) return;
    let b = await this.bounty(t);
    if (!b) return;
    // The simulated transfer arrived (service.fund): the relayer reports it, the escrow allocates it.
    if (t.funded && b.state === "AwaitingDeposit") {
      if (chain.rail === "bank") await chain.call(chain.accounts.relayer, "record_deposit", { ...this.key(t), amount_cents: String(t.policy.amountCents), monerium_order_id: `sim-${t.id}` });
      else await chain.call(chain.accounts.relayer, "record_deposit", { ...this.key(t), units: (BigInt(t.policy.amountCents) * 10_000n).toString(), reference: `${CHAIN_ID}:0x${createHash("sha256").update(t.id).digest("hex")}:00000000` });
      b = (await this.bounty(t))!;
    }
    t.funded = ["Funded", "Disputed", "Closed"].includes(b.state);
    t.disputed = b.state === "Disputed";
    const payout = chain.rail === "usdc" ? (b as SimUsdcBounty).payout
      : (b as SimBankBounty).settlement_payout_id === null ? null : await chain.view<{kind:string}>("get_payout", {payout_id:(b as SimBankBounty).settlement_payout_id});
    if(payout?.kind === "Refund") {
      await this.processed(chain, t);
      t.disputed = true;
      t.refund = {state:"Processed",reference:`SIM-REFUND-${t.id}`,error:null};
    }
  }
  async dispute(t: Task, role: "client" | "developer"): Promise<void> {
    const chain = this.chain(t);
    if (!chain || !(await this.bounty(t))) return;
    await chain.call(role === "client" ? chain.accounts.operator : t.policy.verifier, "open_dispute", this.key(t));
  }
  async release(t: Task): Promise<void> {
    // State + unique release record are committed before the worker calls this method.
    // Repeating after a crash resolves to the same receipt.
    const chain = this.chain(t);
    if (chain) {
      // Same path as the real rails: reconcile first, settle once, for the exact recorded head.
      if (!t.verdict || !t.evidence || t.verdict.status !== "eligible" || evaluateRelease(t,t.evidence).status !== "eligible") throw new Error("No verified merge to settle");
      let headSha: string;
      if (t.policy.market) {
        const { alreadyAuthorized } = await this.market(t).release(t, t.verdict.evidenceHash);
        if (!t.marketSubmission) throw new Error("No timely submission for the current assignment");
        headSha = t.marketSubmission.headSha;
        if (!alreadyAuthorized && chain.rail === "usdc") await this.settleUsdc(chain, t, headSha);
      } else {
        const b = await this.bounty(t);
        if (!b?.assignment || !t.evidence) throw new Error("No on-chain assignment for this task");
        headSha = t.evidence.headSha;
        if (b.assignment.head_sha !== headSha)
          await chain.call(t.policy.verifier, "record_submission", { ...this.key(t), generation: b.assignment.generation, assignment_hash: t.policyHash, head_sha: headSha, observed_at_ns: (BigInt(chain.options.now()) * 1_000_000n).toString() });
        if (chain.rail === "bank" && (b as SimBankBounty).settlement_payout_id === null)
          await chain.call(t.policy.verifier, "settle_bounty", { ...this.key(t), generation: b.assignment.generation, assignment_hash: t.policyHash, head_sha: headSha, evidence_hash: t.verdict.evidenceHash });
        if (chain.rail === "usdc") await this.settleUsdc(chain, t, headSha);
      }
      await this.processed(chain, t);
    }
    t.payment = { state: "Processed", reference: `SIM-${t.id}`, error: null };
    note(t, "Simulated payment completed. No real funds moved.");
    this.store.save(t);
  }
  private async settleUsdc(chain: SimChain, t: Task, headSha: string) {
    const b = (await this.bounty(t)) as SimUsdcBounty;
    if (b.payout) return;
    await chain.call(t.policy.verifier, "settle_bounty", { ...this.key(t), generation: b.assignment!.generation, assignment_hash: t.policyHash, head_sha: headSha, evidence_hash: t.verdict!.evidenceHash, ...SIM_FEES });
  }
  /** The relayer confirms the simulated payout: a Monerium order id, or the USDC transaction hash. */
  private async processed(chain: SimChain, t: Task) {
    const b = await this.bounty(t);
    if (!b) return;
    if (chain.rail === "bank") {
      const id = (b as SimBankBounty).settlement_payout_id;
      const payout = id === null ? null : await chain.view<{ state: string }>("get_payout", { payout_id: id });
      if (payout?.state === "Signed") await chain.call(chain.accounts.relayer, "mark_payout_processed", { payout_id: id, monerium_order_id: `sim-payout-${id}` });
      return;
    }
    const p = (b as SimUsdcBounty).payout;
    if (p?.signature && !p.tx_hash) await chain.call(chain.accounts.relayer, "mark_payout_processed", { bounty_id: t.id, tx_hash: SimChain.signedTxHash(p.unsigned_tx, p.signature) });
  }
  async deposit(t: Task) {
    // Simulated instructions: shown only once the escrow agreement exists. It is NOT a real
    // escrow: never send testnet funds to it.
    if (t.policy.paymentRail === "base-usdc") {
      const b = await this.bounty(t);
      const ready = Boolean(t.clientAccepted && t.fundingPolicyHash);
      const address = this.chain(t)
        ? (b && (b.state === "AwaitingDeposit" || b.state === "Funded") ? b.escrow_evm_address : null)
        : ready ? "0x" + createHash("sha256").update(`nearportal-simulated-escrow:${t.id}:${t.fundingPolicyHash}`).digest("hex").slice(0, 40) : null;
      return { iban: null, reference: t.id, rail: "base-usdc", chainId: CHAIN_ID, token: USDC, address, amountUnits: (BigInt(t.policy.amountCents) * 10_000n).toString(), confirmations: 12, simulated: true };
    }
    return { iban: null, reference: `SIM-${t.id}` };
  }
}

/** Stable bounty ordering prevents two unfunded tasks from mutually blocking the
 * sandbox profile's single movable deposit IBAN after a restart. */
export function fundingBlocker(
  tasks: Task[],
  task: Task,
  profileKey: string,
): Task | undefined {
  return tasks
    .filter(
      (other) =>
        other.id !== task.id &&
        other.mode === "sandbox" &&
        other.jobId !== null &&
        other.clientAccepted &&
        !other.funded &&
        !other.disputed &&
        (other.bankProfileKey === profileKey ||
          (!other.bankProfileKey &&
            (other.ownerId === task.ownerId || !other.ownerId))) &&
        (task.jobId === null || other.jobId < task.jobId),
    )
    .sort((a, b) => a.jobId! - b.jobId!)[0];
}

/** The NEAR → MPC → Monerium bank rail (`contracts/escrow`). Loaded only in explicit sandbox mode. */
export async function sandboxPayments(
  store: TaskStore,
  connection?: { clientId: string; clientSecret: string; ownerId: number },
): Promise<PaymentAdapter> {
  const [
    { env, keyFor, relayerKey },
    { view, call, deriveEscrowAddress },
    { Monerium },
    { Escrow },
    { Store },
    { runPass },
  ] = await Promise.all([
    import("../env.ts"),
    import("../chain.ts"),
    import("../../../../services/relayer/src/monerium.ts"),
    import("../../../../services/relayer/src/near.ts"),
    import("../../../../services/relayer/src/store.ts"),
    import("../../../../services/relayer/src/relayer.ts"),
  ]);
  const verifier = process.env.GITHUB_VERIFIER_ACCOUNT_ID;
  const clientIban = process.env.TASK_CLIENT_IBAN?.replace(
    /\s/g,
    "",
  ).toUpperCase();
  if (
    env.network !== "testnet" ||
    env.monerium.api !== "https://api.monerium.dev" ||
    env.monerium.chain !== "basesepolia"
  )
    throw new Error(
      "GitHub task payments currently support NEAR testnet + Monerium Base Sepolia sandbox only.",
    );
  if (
    !verifier ||
    !clientIban ||
    !env.monerium.clientId ||
    !env.monerium.clientSecret
  )
    throw new Error(
      "Sandbox needs GITHUB_VERIFIER_ACCOUNT_ID, TASK_CLIENT_IBAN and Monerium credentials.",
    );
  // The contract requires owner, verifier and operators to be distinct accounts.
  if (new Set([env.owner, env.client, verifier]).size !== 3)
    throw new Error("Use distinct NEAR accounts for the owner, the operator (client) and the verifier.");
  [env.client, verifier].forEach(keyFor);
  // Fail before creating any bounty if the deployment is not this escrow or not configured for us.
  const deployed = await view<{ owner: string; verifier: string; operators: string[]; max_reward_cents?: string }>("get_config");
  if (!deployed.max_reward_cents || deployed.owner !== env.owner || deployed.verifier !== verifier || !deployed.operators.includes(env.client))
    throw new Error("The escrow's owner, verifier or operator allowlist does not match this configuration.");
  const cfg = {
    moneriumApi: env.monerium.api,
    moneriumClientId: connection?.clientId ?? env.monerium.clientId,
    moneriumClientSecret: connection?.clientSecret ?? env.monerium.clientSecret,
    chain: env.monerium.chain,
    nearRpc: env.nearRpc,
    network: env.network,
    contractId: env.contractId,
    relayerAccountId: env.relayer,
    relayerPrivateKey: relayerKey(env.relayer),
    stateFile: `${env.dataDir}/github-relayer${connection ? `-${connection.ownerId}` : ""}.json`,
    pollSeconds: 20,
  };
  const relayerStore = new Store(cfg.stateFile);
  // Explorer receipts: the relayer records the hash when it marks a payout processed. Older payouts
  // are backfilled once, in the background, by a read-only RPC search verified against the chain.
  const txRpc = jsonRpc(cfg.nearRpc);
  const txLookups = new Map<number, number>(); // payout id → earliest next attempt (ms)
  function processedTx(id: number): string | null {
    const known = relayerStore.state.processedTx?.[id];
    if (known) return known;
    if ((txLookups.get(id) ?? 0) > Date.now()) return null;
    txLookups.set(id, Number.MAX_SAFE_INTEGER); // in flight
    void findPayoutTx(txRpc, { contractId: cfg.contractId, relayerId: cfg.relayerAccountId, payoutId: id })
      .then((hash) => {
        if (hash) {
          relayerStore.state.processedTx ??= {};
          relayerStore.state.processedTx[id] = hash;
          relayerStore.save();
          txLookups.delete(id);
        } else txLookups.set(id, Date.now() + 3_600_000);
      })
      .catch(() => txLookups.set(id, Date.now() + 600_000));
    return null;
  }
  // Incremental payout index: a payout's bounty and kind never change, and a Processed payout is
  // final, so each sync reads only new payouts and this bounty's unfinished ones instead of the
  // whole on-chain history.
  store.db.exec("CREATE TABLE IF NOT EXISTS payout_index(contract TEXT NOT NULL, payout_id INTEGER NOT NULL, bounty_id INTEGER NOT NULL, final TEXT, PRIMARY KEY(contract,payout_id))");
  store.db.exec("CREATE INDEX IF NOT EXISTS payout_index_bounty ON payout_index(contract,bounty_id)");
  async function payoutsOf(bountyId: number, nextPayoutId: number): Promise<{ id: number; payout: any }[]> {
    const row = store.db.prepare("SELECT MAX(payout_id) AS last FROM payout_index WHERE contract=?").get(cfg.contractId) as { last: number | null };
    const fresh = new Map<number, any>();
    for (let id = (row.last ?? -1) + 1; id < nextPayoutId; id++) {
      const payout = await view<any>("get_payout", { payout_id: String(id) });
      if (!payout) break; // not visible yet on this RPC: index it on a later pass, in order
      store.db.prepare("INSERT OR IGNORE INTO payout_index(contract,payout_id,bounty_id) VALUES(?,?,?)").run(cfg.contractId, id, Number(payout.bounty_id));
      fresh.set(id, payout);
    }
    const rows = store.db.prepare("SELECT payout_id AS id, final FROM payout_index WHERE contract=? AND bounty_id=? ORDER BY payout_id").all(cfg.contractId, bountyId) as { id: number; final: string | null }[];
    const out: { id: number; payout: any }[] = [];
    for (const r of rows) {
      const payout = r.final ? JSON.parse(r.final) : fresh.get(r.id) ?? (await view<any>("get_payout", { payout_id: String(r.id) }));
      if (!payout) continue;
      if (!r.final && payout.state === "Processed")
        store.db.prepare("UPDATE payout_index SET final=? WHERE contract=? AND payout_id=?").run(JSON.stringify(payout), cfg.contractId, r.id);
      out.push({ id: r.id, payout });
    }
    return out;
  }
  const moneriumGate = gate("monerium", { concurrency: 2, hourlyBudget: 1200, timeoutMs: 20_000 });
  const monerium = new Monerium(cfg);
  const escrow = new Escrow(cfg);
  const short = shortIban;
  const clientParty = { iban: clientIban!, firstName: "Demo", lastName: "Client", country: clientIban!.slice(0, 2) };
  /** The developer payee registered with the relayer: the claimant's account, none before a claim. */
  const developerParty = (t: Task) => {
    if (t.policy.developerId === 0) return undefined;
    const p = payoutFor(t);
    return { iban: p.iban, firstName: p.firstName, lastName: p.lastName, country: p.country };
  };
  let relayPending = false;
  let relayAttemptAt = 0;
  async function relay() {
    if (relayPending || Date.now() - relayAttemptAt < 15_000) return;
    relayAttemptAt = Date.now();
    // A pass can process any registered bounty: check every destination before it runs.
    for (const [id, record] of Object.entries(relayerStore.state.bounties)) {
      const task = store.all().find((t) => t.jobId === Number(id));
      if (!task) throw new Error("Relayer bounty has no matching task");
      if (hash(record.developer ?? null) !== hash(developerParty(task) ?? null) || hash(record.client) !== hash(clientParty))
        throw new Error(
          "Registered payout destination does not match the accepted task",
        );
    }
    relayPending = true;
    try {
      await runPass(escrow, monerium, relayerStore, (message) =>
        console.log("[github-relayer]", message),
      );
    } finally {
      relayPending = false;
    }
  }
  async function bounty(t: Task) {
    return view<any>("get_bounty", { bounty_id: String(t.jobId) });
  }
  // Deadline bounties on the bank escrow. The relayer's registered developer follows the
  // assignment and is removed when an assignment is cleared.
  const marketRail = bankMarketRail({ view, call: (signer, method, args, deposit) => call(signer, method, args, deposit ?? "0") }, {
    verifier: (t) => t.policy.verifier,
    onCleared: (t) => {
      const rec = t.jobId !== null ? relayerStore.state.bounties[t.jobId] : undefined;
      if (!rec) return;
      delete rec.developer;
      relayerStore.save();
    },
  });
  const adapter: PaymentAdapter = {
    market: () => marketRail,
    async prepare(t) {
      const verifier = t.policy.verifier;
      const fundingHash = t.fundingPolicyHash ?? t.policyHash;
      const profileKey = hash({
        api: cfg.moneriumApi,
        clientId: cfg.moneriumClientId,
      });
      if (t.bankProfileKey && t.bankProfileKey !== profileKey)
        throw new Error(
          "This task belongs to a different bank connection; restore its original connection before continuing.",
        );
      t.bankProfileKey = profileKey;
      store.save(t);
      if (t.jobId === null) await provisioning.run(`rail:${cfg.contractId}`, async () => {
      if (t.jobId !== null) return;
      if (fundingBlocker(store.all(), t, profileKey))
        throw new Error(
          "Fund the existing sandbox task before provisioning another deposit address.",
        );
      {
        const config = await view<{ next_bounty_id: string }>("get_config");
        t.jobId = Number(config.next_bounty_id);
        // Persist the intended id before sending. An uncertain create is reconciled, never
        // blindly repeated against another id.
        store.save(t);
        const path = await view<string>("get_escrow_path", { bounty_id: String(t.jobId) });
        const address = await deriveEscrowAddress(path);
        // The operator account becomes the bounty's client; the verifier is the contract's
        // global verifier, frozen into the bounty.
        await call(
          env.client,
          "create_bounty",
          {
            bounty: {
              funding_policy_hash: fundingHash,
              reward_cents: String(t.policy.amountCents),
              delivery_seconds: deliverySeconds(t),
              refund_short_iban: short(clientIban!),
              escrow_evm_address: address,
            },
          },
          "0.15",
        );
        note(t, `Escrow bounty ${t.jobId} created on NEAR testnet.`);
      }
      });
      let current = await bounty(t);
      if (!current)
        throw new Error(
          "Escrow creation is unconfirmed. Reconcile the saved bounty ID before retrying; do not create another bounty.",
        );
      if (
        current.funding_policy_hash !== fundingHash ||
        current.client !== env.client ||
        current.verifier !== verifier
      )
        throw new Error(
          "The escrow bounty at the saved ID does not match the accepted task.",
        );
      if (
        current.reward_cents !== String(t.policy.amountCents) ||
        current.delivery_seconds !== deliverySeconds(t) ||
        current.refund_short_iban !== short(clientIban!)
      )
        throw new Error(
          "Escrow economics do not match the accepted task policy.",
        );
      if (current.state === "VerifyingAddress") {
        await call(env.client, "retry_address_check", { bounty_id: String(t.jobId) });
        return;
      }
      if (current.state === "Cancelled")
        throw new Error("Escrow address verification failed.");
      if (t.policy.developerId !== 0) {
        const rec = relayerStore.state.bounties[t.jobId!];
        if (rec) {
          rec.developer = developerParty(t);
          relayerStore.save();
        }
        // A contributor may claim while a surplus refund is settling. Process that
        // existing payout before assigning; returning lets sync keep refund status current.
        if (current.open_payouts > 0) {
          await relay();
          current = await bounty(t);
          if (current.open_payouts > 0) return;
        }
        if (t.policy.market) {
          /* assigned by the common lifecycle (generation-sequenced assign_developer) */
        } else if (!current.assignment) {
          if (current.state === "Funded")
            await call(verifier, "assign_developer", {
              bounty_id: String(t.jobId),
              generation: current.generation + 1,
              assignment_hash: t.policyHash,
              developer_id: String(t.policy.developerId),
              recipient_short_iban: short(payoutFor(t).iban),
            });
        } else if (current.assignment.assignment_hash !== t.policyHash)
          throw new Error("On-chain assignment does not match this task");
      }
      if (current.link === "None" || current.link === "Failed")
        await call(env.client, "link_escrow_address", { bounty_id: String(t.jobId) });
      if (!relayerStore.state.bounties[t.jobId!]) await provisioning.run(`rail:${cfg.contractId}`, async () => {
      if (relayerStore.state.bounties[t.jobId!]) return;
      {
        // The sandbox profile has one IBAN: serialize funded tasks instead of silently moving
        // the deposit destination away from another task that is awaiting funding.
        const outstanding = fundingBlocker(store.all(), t, profileKey);
        if (outstanding)
          throw new Error(
            "Fund the existing sandbox task before linking another deposit address.",
          );
        const developer = developerParty(t);
        relayerStore.state.bounties[t.jobId!] = {
          ...(developer ? { developer } : {}),
          client: clientParty,
          moveIbanHere: true,
        };
        relayerStore.save();
      }
      });
      await relay();
    },
    async sync(t) {
      if (t.jobId === null) return;
      await relay();
      const current = await bounty(t);
      if (
        !current ||
        current.funding_policy_hash !== (t.fundingPolicyHash ?? t.policyHash)
      )
        throw new Error("Escrow bounty mismatch");
      t.funded = current.deposited_cents === String(t.policy.amountCents);
      t.disputed = current.state === "Disputed";
      const previousRefunds = t.overpayment?.refunds ?? [];
      t.overpayment = { recordedCents: Number(current.surplus_recorded_cents), refunds: [] };
      const config = await view<{ next_payout_id: string }>("get_config");
      for (const { id, payout } of await payoutsOf(t.jobId, Number(config.next_payout_id))) {
        if (payout?.bounty_id !== String(t.jobId)) continue;
        if (payout.kind === "SurplusRefund") {
          const reference = `near:${env.contractId}:${id}`;
          const state = payout.state === "Signed" && relayerStore.state.pendingSubmissions?.[id]?.error ? "NeedsAttention" : payout.state === "Signed" && relayerStore.state.submitted[id] ? "Submitted" : payout.state;
          const cents = Number(payout.amount_cents);
          t.overpayment.refunds.push({ amountCents: cents, state, reference, txHash: state === "Processed" ? processedTx(id) : null });
          if (state === "Processed" && !previousRefunds.some(p => p.reference === reference && p.state === "Processed")) note(t, `Surplus refund processed: EUR ${(cents / 100).toFixed(2)} returned to the client. ${reference}`);
          continue;
        }
        if (payout.kind === "Refund") {
          t.disputed = true;
          t.refund = {state:payout.state === "SignFailed" ? "NeedsAttention" : payout.state,reference:`near:${env.contractId}:${id}`,error:payout.failure_reason ?? null};
          continue;
        }
        // A dispute refund is never reported as a developer reward.
        if (payout.kind !== "Developer") continue;
        const previousState = t.payment.state;
        t.payment = {
          state:
            payout.state === "Signed"
              ? relayerStore.state.submitted[id]
                ? "Submitted"
                : "Signed"
              : payout.state === "SignFailed"
                ? "NeedsAttention"
                : payout.state,
          reference: `near:${env.contractId}:${id}`,
          error: payout.failure_reason ?? null,
          txHash: payout.state === "Processed" ? processedTx(id) : null,
        };
        if (
          previousState !== t.payment.state &&
          t.payment.state === "Processed"
        )
          note(
            t,
            "Monerium confirmed the reward payout as processed; escrow closed on NEAR.",
          );
        if (
          relayerStore.state.pendingSubmissions?.[id] &&
          !relayerStore.state.submitted[id]
        ) {
          t.payment.state = "NeedsAttention";
          t.payment.error =
            "The redemption outcome is uncertain. Reconciling with Monerium before any further submission.";
        }
      }
    },
    async release(t) {
      const verifier = t.policy.verifier;
      payoutFor(t);
      if (t.jobId === null || !t.verdict || t.verdict.status !== "eligible" || !t.evidence || evaluateRelease(t,t.evidence).status !== "eligible")
        throw new Error("No verified funded bounty to settle");
      const current = await bounty(t);
      if (current.state === "Closed") {
        await adapter.sync(t);
        return;
      }
      if (t.policy.market) {
        // Reconcile first: an authorized payout is followed, never authorized twice.
        const { alreadyAuthorized } = await marketRail.release(t, t.verdict.evidenceHash);
        if (alreadyAuthorized) {
          await adapter.sync(t);
          return;
        }
        t.payment.state = "Signing";
        note(t, "The verifier authorized the fixed reward on NEAR for the exact timely submission. Waiting for MPC and Monerium.");
        store.save(t);
        return;
      }
      // Without a deadline the merged head is recorded first: settlement pays only a recorded head.
      const a = current.assignment;
      if (!a || a.assignment_hash !== t.policyHash)
        throw new Error("The escrow has no assignment for this task");
      const head = t.evidence.headSha;
      if (a.head_sha !== head) {
        const observed = BigInt(Date.parse(t.evidence.observedAt)) * 1_000_000n;
        const start = BigInt(a.submitted_at_ns ?? a.assigned_at_ns);
        await call(verifier, "record_submission", {
          bounty_id: String(t.jobId),
          generation: a.generation,
          assignment_hash: t.policyHash,
          head_sha: head,
          observed_at_ns: (observed > start ? observed : start).toString(),
        });
      }
      await call(verifier, "settle_bounty", {
        bounty_id: String(t.jobId),
        generation: a.generation,
        assignment_hash: t.policyHash,
        head_sha: head,
        evidence_hash: t.verdict.evidenceHash,
      });
      t.payment.state = "Signing";
      note(
        t,
        "The verifier authorized payment on NEAR. Waiting for MPC and Monerium.",
      );
      store.save(t);
    },
    async dispute(t, role) {
      if (t.jobId === null) throw new Error("Escrow has not been created yet");
      // The client side signs as the operator (the bounty's client); the developer side through
      // the verifier, which attests the developer's request.
      await call(role === "client" ? env.client : t.policy.verifier, "open_dispute", {
        bounty_id: String(t.jobId),
      });
    },
    async deposit(t) {
      if (t.jobId === null)
        return { iban: null, reference: `NP-${t.id.slice(0, 8)}` };
      const current = await bounty(t);
      const ibans = await moneriumIbans();
      return {
        iban:
          ibans.find(
            (i) =>
              i.address.toLowerCase() ===
              current?.escrow_evm_address.toLowerCase(),
          )?.iban ?? null,
        reference: `NP-${t.jobId}`,
      };
    },
  };
  // Deposit instructions: one cached client-credentials token per connection (refreshed before
  // expiry or after a 401) and a short-lived IBAN list shared by concurrent readers.
  let moneriumToken: { value: string; expiresAt: number } | undefined;
  let ibanList: { at: number; value: Promise<{ iban: string; address: string }[]> } | undefined;
  async function moneriumAuth(force = false) {
    if (!force && moneriumToken && Date.now() < moneriumToken.expiresAt - 60_000) return moneriumToken.value;
    const result = await moneriumGate.run(async (signal) => {
      const token = await fetch(`${cfg.moneriumApi}/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: cfg.moneriumClientId,
          client_secret: cfg.moneriumClientSecret,
        }),
        signal,
      });
      if (token.status === 429 || token.status >= 500) throw new ProviderFailure(`Monerium unavailable (${token.status})`, retryAfterMs(token.headers.get("retry-after")), token.status);
      if (!token.ok) throw new Error("Monerium authentication failed");
      return (await token.json()) as { access_token: string; expires_in?: number };
    }, { key: `token:${cfg.moneriumClientId}`, op: "auth" });
    moneriumToken = { value: result.access_token, expiresAt: Date.now() + (result.expires_in ?? 600) * 1000 };
    return moneriumToken.value;
  }
  function moneriumIbans() {
    if (ibanList && Date.now() - ibanList.at < 60_000) return ibanList.value;
    const value = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const bearer = await moneriumAuth(attempt > 0);
        const response = await moneriumGate.run((signal) => fetch(`${cfg.moneriumApi}/ibans`, {
          headers: { Authorization: `Bearer ${bearer}`, Accept: "application/vnd.monerium.api-v2+json" },
          signal,
        }).then((r) => {
          if (r.status === 429 || r.status >= 500) throw new ProviderFailure(`Monerium unavailable (${r.status})`, retryAfterMs(r.headers.get("retry-after")), r.status);
          return r;
        }), { op: "ibans" });
        if (response.status === 401 && attempt === 0) continue; // expired token: renew once
        if (!response.ok) throw new Error("Cannot read the sandbox deposit IBAN");
        return ((await response.json()) as { ibans: { iban: string; address: string }[] }).ibans ?? [];
      }
      throw new Error("Monerium authentication failed");
    })();
    ibanList = { at: Date.now(), value };
    value.catch(() => { if (ibanList?.value === value) ibanList = undefined; });
    return value;
  }
  return adapter;
}
