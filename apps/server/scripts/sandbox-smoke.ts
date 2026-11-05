// Verifies real MPC address derivation and ownership signing without reporting a bank deposit.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
process.env.ENV_FILE ??= ".env.sandbox";
const { env } = await import("../server/env.ts");
const { call, view, deriveEscrowAddress, invalidateViews } = await import("../server/chain.ts");
if (env.network !== "testnet") throw new Error("Testnet only");
const verifier = process.env.GITHUB_VERIFIER_ACCOUNT_ID;
if (!verifier) throw new Error("Missing verifier account");
const path = "data/sandbox/smoke.json";
const hash = createHash("sha256").update("NearPortal testnet infrastructure verification: no bank funding, no reward payment").digest("hex");
interface Smoke { contractId: string; jobId: number; address: string; submitted: boolean; verified?: boolean }
let smoke: Smoke | null = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const save = () => writeFileSync(path, JSON.stringify(smoke, null, 2), { mode: 0o600 });
async function waitFor<T>(run: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 35; i++) {
    invalidateViews();
    const value = await run();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("MPC callback still pending; rerun the smoke check to reconcile");
}
try {
  if (!smoke) {
    const cfg = await view<{ next_job_id: number }>("get_config");
    const derivationPath = await view<string>("get_escrow_path", { job_id: cfg.next_job_id });
    const address = await deriveEscrowAddress(derivationPath);
    smoke = { contractId: env.contractId, jobId: cfg.next_job_id, address, submitted: false }; save();
  }
  if (smoke.contractId !== env.contractId) throw new Error("Smoke record belongs to another contract");
  let job = await view<any>("get_job", { job_id: smoke.jobId });
  if (!job) {
    if (smoke.submitted) throw new Error("Previous create is uncertain; inspect the saved job ID instead of blindly resubmitting");
    smoke.submitted = true; save();
    await call(env.artisan, "create_job", { job: {
      github_release: { policy_hash: hash, verifier }, client: env.client, mediator: env.mediator, agent: null,
      terms_hash: hash, pdf_hash: hash, evidence_hash: hash, total_cents: 100,
      milestones: [{ label: "Unfunded infrastructure check", amount_cents: 100 }], off_premises: false,
      artisan_short_iban: `${env.artisanIban.slice(0, 4)}...${env.artisanIban.slice(-4)}`, escrow_evm_address: smoke.address,
    } }, "0.15");
  }
  job = await waitFor(() => view<any>("get_job", { job_id: smoke!.jobId }), (j) => j && j.state !== "VerifyingAddress");
  if (job.terms_hash !== hash || job.escrow_evm_address.toLowerCase() !== smoke.address.toLowerCase()) throw new Error("Smoke job mismatch");
  if (job.state === "Cancelled") throw new Error("MPC escrow address verification failed");
  console.log(`READY contract verified the MPC-derived address for job ${smoke.jobId}`);
  const mandate = await view<{ policy_hash: string; verifier: string }>("get_release_policy", { job_id: smoke.jobId });
  if (mandate.policy_hash !== hash || mandate.verifier !== verifier) throw new Error("Verifier mandate mismatch");
  if (job.state === "AwaitingClient") await call(env.client, "accept_terms", { job_id: smoke.jobId, acceptance: {
    release_policy_hash: hash, release_verifier: verifier, terms_hash: hash, pdf_hash: hash, evidence_hash: hash,
    mediator: env.mediator, off_premises: false, total_cents: 100, milestone_amounts_cents: [100],
    artisan_short_iban: job.artisan_short_iban, escrow_evm_address: smoke.address,
    client_short_iban: `${process.env.TASK_CLIENT_IBAN!.slice(0, 4)}...${process.env.TASK_CLIENT_IBAN!.slice(-4)}`,
  } });
  job = await view<any>("get_job", { job_id: smoke.jobId });
  if (job.link === "None" || job.link === "Failed") await call(env.artisan, "link_escrow_address", { job_id: smoke.jobId });
  job = await waitFor(() => view<any>("get_job", { job_id: smoke!.jobId }), (j) => typeof j.link === "object" || j.link === "Failed");
  if (typeof job.link !== "object" || !job.link.Signed) throw new Error("MPC ownership signature failed");
  if (job.deposited_cents !== 0 || job.committed_cents !== 0) throw new Error("Infrastructure smoke job must remain unfunded");
  smoke.verified = true; save();
  console.log("READY client accepted the verifier identity and policy hash on-chain");
  console.log("READY real MPC ownership signature verified by the deployed contract");
  console.log("No deposit was reported, no Monerium address was linked, and no payout was requested.");
} catch (error) { console.error(error instanceof Error ? error.message.slice(0, 400) : "Smoke check failed"); process.exitCode = 1; }
