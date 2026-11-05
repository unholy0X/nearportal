import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Account, KeyPair, nearToYocto, type KeyPairString } from "near-api-js";
import bs58 from "bs58";
import { rpcProvider } from "../../../services/relayer/src/near.ts";

process.env.ENV_FILE ??= ".env.sandbox";
const { env, keyFor, relayerKey } = await import("../server/env.ts");
let ready = true;
try {
  if (env.network !== "testnet" || !env.contractId.endsWith(".testnet") || env.monerium.api !== "https://api.monerium.dev" || env.monerium.chain !== "basesepolia") throw new Error("Sandbox network configuration mismatch");
  const provider = rpcProvider(env.nearRpc);
  const contract = new Account(env.contractId, provider);
  const state = await contract.getState();
  const localHash = bs58.encode(createHash("sha256").update(readFileSync(process.env.ESCROW_WASM ?? "../../contracts/escrow/target/wasm32-unknown-unknown/release/nearportal_escrow.wasm")).digest());
  if (state.codeHash !== localHash) throw new Error("Deployed WASM hash differs from the local build");
  const cfg = await provider.callFunction({ contractId: env.contractId, method: "get_config", args: {} }) as { relayer: string; mpc_contract: string };
  if (cfg.relayer !== env.relayer || cfg.mpc_contract !== env.mpcContract) throw new Error("Contract configuration mismatch");
  await provider.callFunction({ contractId: env.contractId, method: "get_release_policy", args: { job_id: 0 } });
  console.log(`READY NEAR testnet contract: ${env.contractId}`);
  console.log(`READY deployed code hash: ${localHash}`);
  const roles = { provider: env.artisan, client: env.client, mediator: env.mediator, relayer: env.relayer, verifier: process.env.GITHUB_VERIFIER_ACCOUNT_ID ?? "" };
  for (const [role, id] of Object.entries(roles)) {
    if (!id) throw new Error(`Missing ${role} account ID`);
    const secret = role === "relayer" ? relayerKey(id) : keyFor(id);
    const signer = new Account(id, provider, secret as KeyPairString);
    const access = await signer.getAccessKey(KeyPair.fromString(secret as KeyPairString).getPublicKey());
    if ((role === "verifier" || role === "relayer") && typeof access.permission === "object") {
      const call = access.permission.FunctionCall;
      const expected = role === "verifier" ? ["release_verified_milestone", ...(process.env.PORTAL_OPEN_BOUNTY_ENABLED === "1" ? ["bind_bounty_submission"] : [])] : ["record_deposit", "record_excess", "mark_payout_processed"];
      if (call.receiver_id !== env.contractId || expected.some((method) => !call.method_names.includes(method)) || call.method_names.length !== expected.length) throw new Error(`Unexpected ${role} signing permissions`);
      const minimum = nearToYocto(role === "verifier" ? "0.35" : "0.15");
      if (call.allowance != null && BigInt(call.allowance) < minimum) throw new Error(`${role} key allowance is too low for prepaid testnet gas`);
    } else if (role === "verifier" || role === "relayer") throw new Error(`${role} should use a scoped function-call key`);
    const minimum = nearToYocto(role === "provider" ? "0.5" : role === "relayer" ? "0.15" : "0.35");
    if ((await signer.getState()).balance.available < minimum) throw new Error(`${role} needs a larger testnet gas reserve`);
    console.log(`READY ${role} account and signing key`);
  }
} catch (error) { ready = false; console.error(error instanceof Error ? error.message.slice(0, 300) : "NEAR readiness check failed"); }

if (!process.argv.includes("--near-only")) {
  const missing = ["MONERIUM_CLIENT_ID", "MONERIUM_CLIENT_SECRET"].filter((key) => !process.env[key]);
  if (missing.length) { ready = false; console.log(`PENDING fill ${missing.join(" and ")} in .env.sandbox (do not paste secrets into chat).`); }
  else try {
    const tokenResponse = await fetch(`${env.monerium.api}/auth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.monerium.clientId, client_secret: env.monerium.clientSecret }), signal: AbortSignal.timeout(20_000) });
    if (!tokenResponse.ok) throw new Error(`Monerium sandbox authentication failed (HTTP ${tokenResponse.status})`);
    const token = await tokenResponse.json() as { access_token: string };
    if (!token.access_token) throw new Error("Monerium returned no access token");
    const api = async <T>(path: string): Promise<T> => {
      const response = await fetch(`${env.monerium.api}${path}`, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.monerium.api-v2+json" }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`Monerium sandbox check failed (HTTP ${response.status})`);
      return await response.json() as T;
    };
    const context = await api<{ defaultProfile: string }>("/auth/context");
    if (!context.defaultProfile) throw new Error("The Private app has no default sandbox profile");
    const profiles = await api<{ profiles: { id: string; state: string }[] }>("/profiles");
    const profile = profiles.profiles.find((p) => p.id === context.defaultProfile);
    if (!profile) throw new Error("Default sandbox profile was not returned by the Private app");
    const ibans = await api<{ ibans: unknown[] }>("/ibans");
    // Developer sandbox accounts may expose a seeded profile as "created" with an
    // already provisioned fake IBAN. Do not claim this is production KYC approval.
    if (profile.state !== "approved" && !(profile.state === "created" && ibans.ibans?.length)) throw new Error(`Sandbox profile is ${profile.state}; finish sandbox onboarding first`);
    console.log(`READY Monerium sandbox Private app authentication and default profile (${profile.state})`);
    console.log(ibans.ibans?.length ? "READY sandbox EUR IBAN exists (value not printed)" : "PENDING first IBAN will be provisioned after linking a job address");
  } catch (error) { ready = false; console.error(error instanceof Error ? error.message : "Monerium readiness check failed"); }
}
console.log("Read-only check finished. No bank transfer or payout was submitted.");
process.exitCode = ready ? 0 : 1;
