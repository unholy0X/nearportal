// Links the infrastructure address and verifies the sandbox IBAN, without minting or redeeming.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Monerium } from "../../../services/relayer/src/monerium.ts";
import { rpcProvider } from "../../../services/relayer/src/near.ts";
process.env.ENV_FILE ??= ".env.sandbox";
const { env } = await import("../server/env.ts");
try {
  if (env.network !== "testnet" || env.monerium.api !== "https://api.monerium.dev" || env.monerium.chain !== "basesepolia") throw new Error("Sandbox only");
  if (!env.monerium.clientId || !env.monerium.clientSecret) throw new Error("Fill the Monerium sandbox credentials in .env.sandbox first");
  const smoke = JSON.parse(readFileSync("data/sandbox/smoke.json", "utf8")) as { verified: boolean; contractId: string; jobId: number; address: string };
  if (!smoke.verified || smoke.contractId !== env.contractId) throw new Error("Complete sandbox:smoke on this contract first");
  const provider = rpcProvider(env.nearRpc);
  const config = await provider.callFunction({ contractId: env.contractId, method: "get_config", args: {} }) as { next_job_id: number };
  if (config.next_job_id !== smoke.jobId + 1) throw new Error("Task jobs already exist; use their funding flow instead of moving the IBAN to the infrastructure address");
  const job = await provider.callFunction({ contractId: env.contractId, method: "get_job", args: { job_id: smoke.jobId } }) as { escrow_evm_address: string; deposited_cents: number; link: { Signed?: string } };
  if (job.escrow_evm_address.toLowerCase() !== smoke.address.toLowerCase() || job.deposited_cents !== 0 || !job.link.Signed) throw new Error("Infrastructure job is not a verified, unfunded MPC address");
  const monerium = new Monerium({
    moneriumApi: env.monerium.api, moneriumClientId: env.monerium.clientId, moneriumClientSecret: env.monerium.clientSecret,
    chain: env.monerium.chain, nearRpc: env.nearRpc, network: "testnet", contractId: env.contractId,
    relayerAccountId: env.relayer, relayerPrivateKey: "", stateFile: "", pollSeconds: 20,
  });
  await monerium.linkAddress(smoke.address, "I hereby declare that I am the address owner.", job.link.Signed);
  let ibans = await monerium.ibans();
  if (!ibans.length) throw new Error("The sandbox profile needs an IBAN provisioned before routing can be verified");
  const match = () => ibans.find((i) => i.chain === env.monerium.chain && i.address.toLowerCase() === smoke.address.toLowerCase());
  if (!match()) { await monerium.moveIban(smoke.address); ibans = await monerium.ibans(); }
  const linked = match();
  if (!linked) throw new Error("IBAN routing change is still pending; rerun to reconcile");
  const record = { network: "sandbox", chain: env.monerium.chain, contractId: env.contractId, address: smoke.address, ibanSha256: createHash("sha256").update(linked.iban).digest("hex"), verifiedAt: new Date().toISOString() };
  writeFileSync("data/sandbox/monerium-setup.json", JSON.stringify(record, null, 2), { mode: 0o600 });
  console.log("READY Monerium accepted the contract's real MPC ownership signature");
  console.log("READY sandbox EUR IBAN routes to the NEAR-controlled Base Sepolia address");
  console.log("No incoming transfer, mint, redemption or payout was requested. Do not fund this infrastructure address; use a funded task's instructions later.");
} catch (error) { console.error(error instanceof Error ? error.message.slice(0, 300) : "Sandbox bank setup failed"); process.exitCode = 1; }
