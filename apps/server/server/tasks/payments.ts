import { createHash } from "node:crypto";
import { CHAIN_ID, USDC } from "../crypto/evm.ts";
import { findPayoutTx, jsonRpc } from "./payout-tx.ts";
import { gate, ProviderFailure, retryAfterMs } from "../ops/provider.ts";
import { KeyedLock } from "../ops/locks.ts";
import { bankMarketRail, cryptoMarketRail, type MarketRail } from "../market/rail.ts";
import type { SimChain } from "../market/sim-chain.ts";

// Shared sandbox rail state needs mutual exclusion across tasks: the escrow job-id reservation
// (read next_job_id, then create_job) and registration of the single movable deposit IBAN.
// Everything else runs per task in parallel.
const provisioning = new KeyedLock();
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

export class SimulatedPayments implements PaymentAdapter {
  private rails?: { bank: MarketRail; usdc: MarketRail };
  constructor(private readonly store: TaskStore, private readonly chain?: SimChain) {
    if (chain) this.rails = {
      bank: bankMarketRail(chain, { client: "sim-client", verifier: () => "sim-verifier", jobOf: (t) => t.id }),
      usdc: cryptoMarketRail(chain, { client: "sim-client", verifier: "sim-verifier" }),
    };
  }
  market(t: Task): MarketRail {
    if (!this.rails) throw new Error("Deadline bounties need the simulated escrow chain");
    return t.policy.paymentRail === "base-usdc" ? this.rails.usdc : this.rails.bank;
  }
  async prepare(_t: Task): Promise<void> {}
  async sync(_t: Task): Promise<void> {}
  async dispute(_t: Task, _role: "client" | "developer"): Promise<void> {}
  async release(t: Task): Promise<void> {
    // State + unique release record are committed before the worker calls this method.
    // Repeating after a crash resolves to the same receipt.
    if (t.policy.market) {
      // Same path as the real rails: reconcile first, authorize once, for the exact timely head.
      const a = t.policy.assignment, s = t.marketSubmission;
      if (!this.chain || !a || !s || !t.verdict) throw new Error("No timely submission for the current assignment");
      const { alreadyAuthorized } = await this.market(t).release(t, t.verdict.evidenceHash);
      if (!alreadyAuthorized && t.policy.paymentRail === "base-usdc")
        await this.chain.call("sim-verifier", "release_crypto_market", { id: t.id, generation: a.generation, policy_hash: t.policyHash, head_sha: s.headSha, evidence_hash: t.verdict.evidenceHash });
    }
    t.payment = { state: "Processed", reference: `SIM-${t.id}`, error: null };
    note(t, "Simulated payment completed. No real funds moved.");
    this.store.save(t);
  }
  async deposit(t: Task) {
    // Simulated USDC instructions: one deterministic, bounty-specific address, shown only once the
    // escrow agreement exists. It is NOT a real escrow: never send testnet funds to it.
    if (t.policy.paymentRail === "base-usdc") {
      const ready = Boolean(t.clientAccepted && t.fundingPolicyHash);
      const address = ready ? "0x" + createHash("sha256").update(`nearportal-simulated-escrow:${t.id}:${t.fundingPolicyHash}`).digest("hex").slice(0, 40) : null;
      return { iban: null, reference: t.id, rail: "base-usdc", chainId: CHAIN_ID, token: USDC, address, amountUnits: (BigInt(t.policy.amountCents) * 10_000n).toString(), confirmations: 12, simulated: true };
    }
    return { iban: null, reference: `SIM-${t.id}` };
  }
}

/** Stable job ordering prevents two unfunded tasks from mutually blocking the
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
        (other.developerAccepted || other.openBounty) &&
        !other.funded &&
        !other.disputed &&
        (other.bankProfileKey === profileKey ||
          (!other.bankProfileKey &&
            (other.ownerId === task.ownerId || !other.ownerId))) &&
        (task.jobId === null || other.jobId < task.jobId),
    )
    .sort((a, b) => a.jobId! - b.jobId!)[0];
}

/** Reuses the existing NEAR → MPC → Monerium path. Loaded only in explicit sandbox mode. */
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
  if ([env.artisan, env.client, env.mediator].includes(verifier))
    throw new Error("Use an independent verifier NEAR account.");
  [env.artisan, env.client, env.mediator, verifier].forEach(keyFor);
  // Fail before creating any job if the deployment lacks the new mandate API.
  await view("get_release_policy", { job_id: 0 });
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
  // Incremental payout index: a payout's job and kind never change, and a Processed payout is
  // final, so each sync reads only new payouts and this job's unfinished ones instead of the
  // whole on-chain history.
  store.db.exec("CREATE TABLE IF NOT EXISTS payout_index(contract TEXT NOT NULL, payout_id INTEGER NOT NULL, job_id INTEGER NOT NULL, final TEXT, PRIMARY KEY(contract,payout_id))");
  store.db.exec("CREATE INDEX IF NOT EXISTS payout_index_job ON payout_index(contract,job_id)");
  async function payoutsOf(jobId: number, nextPayoutId: number): Promise<{ id: number; payout: any }[]> {
    const row = store.db.prepare("SELECT MAX(payout_id) AS last FROM payout_index WHERE contract=?").get(cfg.contractId) as { last: number | null };
    const fresh = new Map<number, any>();
    for (let id = (row.last ?? -1) + 1; id < nextPayoutId; id++) {
      const payout = await view<any>("get_payout", { payout_id: id });
      if (!payout) break; // not visible yet on this RPC: index it on a later pass, in order
      store.db.prepare("INSERT OR IGNORE INTO payout_index(contract,payout_id,job_id) VALUES(?,?,?)").run(cfg.contractId, id, payout.job_id);
      fresh.set(id, payout);
    }
    const rows = store.db.prepare("SELECT payout_id AS id, final FROM payout_index WHERE contract=? AND job_id=? ORDER BY payout_id").all(cfg.contractId, jobId) as { id: number; final: string | null }[];
    const out: { id: number; payout: any }[] = [];
    for (const r of rows) {
      const payout = r.final ? JSON.parse(r.final) : fresh.get(r.id) ?? (await view<any>("get_payout", { payout_id: r.id }));
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
  const recipient = (t: Task) =>
    t.openBounty && t.policy.developerId === 0
      ? {
          iban: env.artisanIban,
          firstName: env.artisanFirstName,
          lastName: env.artisanLastName,
          country: env.artisanIban.slice(0, 2),
        }
      : payoutFor(t);
  let relayPending = false;
  let relayAttemptAt = 0;
  async function relay() {
    if (relayPending || Date.now() - relayAttemptAt < 15_000) return;
    relayAttemptAt = Date.now();
    // A pass can process any registered job: check every destination before it runs.
    for (const [id, record] of Object.entries(relayerStore.state.jobs)) {
      const task = store.all().find((t) => t.jobId === Number(id));
      if (!task) throw new Error("Relayer job has no matching task");
      const p = recipient(task);
      const expected = {
        iban: p.iban,
        firstName: p.firstName,
        lastName: p.lastName,
        country: p.country,
      };
      if (hash(record.artisan) !== hash(expected))
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
  async function job(t: Task) {
    return view<any>("get_job", { job_id: t.jobId });
  }
  // Fixed-deadline market rail on the bank escrow (market.rs). The relayer's registered destination
  // follows the bound assignment and returns to the placeholder when an assignment is cleared.
  const marketRail = bankMarketRail({ view, call: (signer, method, args, deposit) => call(signer, method, args, deposit ?? "0") }, {
    client: env.client,
    verifier: (t) => t.policy.verifier,
    onCleared: (t) => {
      const rec = t.jobId !== null ? relayerStore.state.jobs[t.jobId] : undefined;
      if (!rec) return;
      rec.artisan = { iban: env.artisanIban, firstName: env.artisanFirstName, lastName: env.artisanLastName, country: env.artisanIban.slice(0, 2) };
      relayerStore.save();
    },
  });
  const adapter: PaymentAdapter = {
    market: () => marketRail,
    async prepare(t) {
      const verifier = t.policy.verifier;
      const payout = recipient(t);
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
        const config = await view<{ next_job_id: number }>("get_config");
        t.jobId = config.next_job_id;
        // Persist the intended id before sending. An uncertain create is reconciled, never
        // blindly repeated against another id.
        store.save(t);
        const path = await view<string>("get_escrow_path", { job_id: t.jobId });
        const address = await deriveEscrowAddress(path);
        await call(
          env.artisan,
          "create_job",
          {
            job: {
              github_release: { policy_hash: fundingHash, verifier },
              client: env.client,
              mediator: env.mediator,
              agent: null,
              terms_hash: fundingHash,
              pdf_hash: hash({ criteria: t.policy.criteria }),
              evidence_hash: hash({ task: t.id, policyHash: fundingHash }),
              total_cents: t.policy.amountCents,
              milestones: [
                {
                  label: "Verified GitHub merge",
                  amount_cents: t.policy.amountCents,
                },
              ],
              off_premises: false,
              artisan_short_iban: short(payout.iban),
              escrow_evm_address: address,
            },
          },
          "0.15",
        );
        note(t, `Escrow job ${t.jobId} created on NEAR testnet.`);
      }
      });
      let current = await job(t);
      if (!current)
        throw new Error(
          "Escrow creation is unconfirmed. Reconcile the reserved job ID before retrying; do not create another job.",
        );
      if (
        current.terms_hash !== (t.fundingPolicyHash ?? t.policyHash) ||
        current.artisan !== env.artisan ||
        current.client !== env.client
      )
        throw new Error(
          "Reserved escrow job does not match the accepted task.",
        );
      if (
        current.total_cents !== t.policy.amountCents ||
        current.milestones.length !== 1 ||
        current.milestones[0].amount_cents !== t.policy.amountCents ||
        // Deadline bounties re-bind the destination per assignment on chain (bind_market_assignment);
        // the assignment policy hash commits it, so the legacy one-time comparison does not apply.
        (!t.policy.market &&
          current.artisan_short_iban !== short(payout.iban) &&
          !(
            t.openBounty &&
            current.artisan_short_iban === short(env.artisanIban)
          )) ||
        current.off_premises
      )
        throw new Error(
          "Escrow economics do not match the accepted task policy.",
        );
      const mandate = await view<{
        policy_hash: string;
        verifier: string;
      } | null>("get_release_policy", { job_id: t.jobId });
      if (
        ![fundingHash, t.policyHash].includes(mandate?.policy_hash ?? "") ||
        mandate?.verifier !== verifier
      )
        throw new Error(
          "Escrow deployment has no matching GitHub verifier mandate.",
        );
      if (current.state === "VerifyingAddress") return;
      if (current.state === "Cancelled")
        throw new Error("Escrow address verification failed.");
      if (current.state === "AwaitingClient") {
        if (
          t.openBounty &&
          !(await view("get_open_bounty_mandate", { job_id: t.jobId }))
        )
          await call(env.client, "authorize_open_bounty", {
            job_id: t.jobId,
            funding_policy_hash: fundingHash,
          });
        // Fixed-deadline terms are written to the escrow before the client accepts and funds.
        if (t.policy.market) await marketRail.configure(t);
        await call(env.client, "accept_terms", {
          job_id: t.jobId,
          acceptance: {
            release_policy_hash: fundingHash,
            release_verifier: verifier,
            terms_hash: current.terms_hash,
            pdf_hash: current.pdf_hash,
            evidence_hash: current.evidence_hash,
            mediator: current.mediator,
            off_premises: current.off_premises,
            total_cents: current.total_cents,
            milestone_amounts_cents: current.milestones.map(
              (m: { amount_cents: number }) => m.amount_cents,
            ),
            artisan_short_iban: current.artisan_short_iban,
            escrow_evm_address: current.escrow_evm_address,
            client_short_iban: short(clientIban!),
          },
        });
        current = await job(t);
      }
      if (t.openBounty && t.policy.developerId !== 0) {
        if (relayerStore.state.jobs[t.jobId!]) {
          relayerStore.state.jobs[t.jobId!]!.artisan = {
            iban: payout.iban,
            firstName: payout.firstName,
            lastName: payout.lastName,
            country: payout.country,
          };
          relayerStore.save();
        }
        // A contributor may claim while a surplus refund is settling. Process that
        // existing payout before binding; returning lets sync keep refund status current.
        if (current.open_payouts > 0) {
          await relay();
          current = await job(t);
          if (current.open_payouts > 0) return;
        }
        const open = await view<{ bound_policy_hash: string | null }>(
          "get_open_bounty_mandate",
          { job_id: t.jobId },
        );
        if (!open) throw new Error("Open bounty mandate missing");
        if (t.policy.market) {
          /* bound by the common lifecycle through bind_market_assignment (generation-sequenced) */
        } else if (!open.bound_policy_hash) {
          await call(verifier, "bind_bounty_submission", {
            job_id: t.jobId,
            funding_policy_hash: fundingHash,
            policy_hash: t.policyHash,
            recipient_short_iban: short(payout.iban),
          });
        } else if (open.bound_policy_hash !== t.policyHash)
          throw new Error("On-chain claimant does not match this task");
      }
      if (current.link === "None" || current.link === "Failed")
        await call(env.artisan, "link_escrow_address", { job_id: t.jobId });
      if (!relayerStore.state.jobs[t.jobId!]) await provisioning.run(`rail:${cfg.contractId}`, async () => {
      if (relayerStore.state.jobs[t.jobId!]) return;
      {
        // The sandbox profile has one IBAN: serialize funded tasks instead of silently moving
        // the deposit destination away from another task that is awaiting funding.
        const outstanding = fundingBlocker(store.all(), t, profileKey);
        if (outstanding)
          throw new Error(
            "Fund the existing sandbox task before linking another deposit address.",
          );
        relayerStore.state.jobs[t.jobId!] = {
          artisan: {
            iban: payout.iban,
            firstName: payout.firstName,
            lastName: payout.lastName,
            country: payout.country,
          },
          client: {
            iban: clientIban!,
            firstName: "Demo",
            lastName: "Client",
            country: clientIban!.slice(0, 2),
          },
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
      const current = await job(t);
      if (
        !current ||
        current.terms_hash !== (t.fundingPolicyHash ?? t.policyHash)
      )
        throw new Error("Escrow job mismatch");
      t.funded = current.deposited_cents === t.policy.amountCents;
      t.disputed ||= current.state === "Disputed";
      const previousRefunds = t.overpayment?.refunds ?? [];
      t.overpayment = { recordedCents: current.excess_recorded_cents ?? 0, refunds: [] };
      const config = await view<{ next_payout_id: number }>("get_config");
      for (const { id, payout } of await payoutsOf(t.jobId, config.next_payout_id)) {
        if (payout?.job_id !== t.jobId) continue;
        if (payout.kind === "ExcessRefund") {
          const reference = `near:${env.contractId}:${id}`;
          const state = payout.state === "Signed" && relayerStore.state.pendingSubmissions?.[id]?.error ? "NeedsAttention" : payout.state === "Signed" && relayerStore.state.submitted[id] ? "Submitted" : payout.state;
          t.overpayment.refunds.push({ amountCents: payout.amount_cents, state, reference, txHash: state === "Processed" ? processedTx(id) : null });
          if (state === "Processed" && !previousRefunds.some(p => p.reference === reference && p.state === "Processed")) note(t, `Surplus refund processed: EUR ${(payout.amount_cents / 100).toFixed(2)} returned to the client. ${reference}`);
          continue;
        }
        if (!payout.kind?.Release) continue;
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
      if (t.jobId === null || !t.verdict || t.verdict.status !== "eligible")
        throw new Error("No verified funded job to release");
      const current = await job(t);
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
      await call(verifier, "release_verified_milestone", {
        job_id: t.jobId,
        policy_hash: t.policyHash,
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
      await call(role === "client" ? env.client : env.artisan, "open_dispute", {
        job_id: t.jobId,
      });
    },
    async deposit(t) {
      if (t.jobId === null)
        return { iban: null, reference: `NP-${t.id.slice(0, 8)}` };
      const current = await job(t);
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
