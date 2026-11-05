// Isolated NEAR testnet deployment. Only public keys leave this machine.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Account, actions, KeyPair, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import bs58 from "bs58";
import { rpcProvider } from "../../../services/relayer/src/near.ts";

const rpc = "https://test.rpc.fastnear.com,https://rpc.testnet.near.org";
const provider = rpcProvider(rpc);
const directory = resolve("data/sandbox");
const credentials = join(directory, "keys");
mkdirSync(credentials, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700); chmodSync(credentials, 0o700);
const manifestPath = join(directory, "deployment.json");
interface Manifest { network: "testnet"; root: string; accounts: Record<string, string>; transactions: { action: string; hash: string }[]; codeHash?: string; initialized?: boolean }
const manifest: Manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {
  network: "testnet", root: `nearportal-pr-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex")}.testnet`, accounts: {}, transactions: [],
};
if (manifest.network !== "testnet" || !/^[a-z0-9-]+\.testnet$/.test(manifest.root)) throw new Error("Only an isolated .testnet root is supported");
const save = () => { writeFileSync(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2), { mode: 0o600 }); renameSync(`${manifestPath}.tmp`, manifestPath); };
save();
const roles = ["escrow", "provider", "client", "mediator", "relayer", "verifier"];
for (const role of roles) manifest.accounts[role] ??= `${role}.${manifest.root}`;
save();
function localKey(id: string) {
  const file = join(credentials, `${id}.json`);
  if (!existsSync(file)) {
    const pair = KeyPair.fromRandom("ed25519");
    writeFileSync(file, JSON.stringify({ account_id: id, public_key: pair.getPublicKey().toString(), private_key: pair.toString() }), { mode: 0o600, flag: "wx" });
  }
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (record.account_id !== id) throw new Error("Local key account mismatch");
  return KeyPair.fromString(record.private_key as KeyPairString);
}
const account = (id: string) => new Account(id, provider, localKey(id).toString());
async function state(id: string) {
  try { return await new Account(id, provider).getState(); }
  catch (error) { if (/UNKNOWN_ACCOUNT|does not exist/i.test(String(error))) return null; throw error; }
}
async function verifyKey(id: string) { await account(id).getAccessKey(localKey(id).getPublicKey()); }
function receipt(action: string, outcome: any) {
  if (outcome.status?.Failure) throw new Error(`Transaction failed: ${action}`);
  const tx = outcome.transaction?.hash;
  if (typeof tx !== "string") throw new Error(`No transaction receipt for ${action}; reconcile before retrying`);
  manifest.transactions.push({ action, hash: tx }); save();
  console.log(`${action}: ${tx}`);
}
function updateEnvironment() {
  const path = resolve(".env.sandbox");
  const updates: Record<string, string> = {
    NEAR_NETWORK: "testnet", NEAR_RPC: rpc, NEAR_CREDENTIALS_DIR: credentials,
    ESCROW_CONTRACT_ID: manifest.accounts.escrow!, ARTISAN_ACCOUNT_ID: manifest.accounts.provider!,
    CLIENT_ACCOUNT_ID: manifest.accounts.client!, MEDIATOR_ACCOUNT_ID: manifest.accounts.mediator!,
    RELAYER_ACCOUNT_ID: manifest.accounts.relayer!, GITHUB_VERIFIER_ACCOUNT_ID: manifest.accounts.verifier!,
    MPC_CONTRACT: "v1.signer-prod.testnet",
  };
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const result = lines.map((line) => { const key = line.slice(0, line.indexOf("=")); if (!(key in updates)) return line; const value = `${key}=${updates[key]}`; delete updates[key]; return value; });
  for (const [key, value] of Object.entries(updates)) result.push(`${key}=${value}`);
  writeFileSync(path, result.join("\n"), { mode: 0o600 }); chmodSync(path, 0o600);
}

try {
  const response = await fetch("https://test.rpc.fastnear.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "network", method: "status", params: [] }), signal: AbortSignal.timeout(20_000) });
  const status = await response.json() as { result?: { chain_id: string } };
  if (status.result?.chain_id !== "testnet") throw new Error("RPC did not confirm testnet");
  const wasm = readFileSync(resolve(process.env.ESCROW_WASM ?? "../../contracts/escrow/target/wasm32-unknown-unknown/release/nearportal_escrow.wasm"));
  const codeHash = bs58.encode(createHash("sha256").update(wasm).digest());
  const rootKey = localKey(manifest.root);
  if (!(await state(manifest.root))) {
    console.log(`Requesting faucet sponsorship for ${manifest.root}`);
    const sponsor = await fetch("https://helper.testnet.near.org/account", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newAccountId: manifest.root, newAccountPublicKey: rootKey.getPublicKey().toString() }), signal: AbortSignal.timeout(45_000),
    });
    if (!sponsor.ok) throw new Error(`Testnet faucet returned HTTP ${sponsor.status}; root public key is saved locally for manual testnet sponsorship`);
    await sponsor.text();
  }
  const rootState = await state(manifest.root);
  if (!rootState) throw new Error("Faucet account creation is not yet confirmed; rerun to reconcile");
  await verifyKey(manifest.root);
  // A function-call key's allowance must cover the prepaid gas reservation, not just
  // the amount ultimately burnt. Re-key an unused bootstrap verifier if necessary.
  if (manifest.initialized && await state(manifest.accounts.verifier!)) {
    const access = await account(manifest.accounts.verifier!).getAccessKey(localKey(manifest.accounts.verifier!).getPublicKey());
    if (typeof access.permission === "object" && access.permission.FunctionCall.allowance != null && BigInt(access.permission.FunctionCall.allowance) < nearToYocto("0.5")) {
      const cfg = await provider.callFunction({ contractId: manifest.accounts.escrow!, method: "get_config", args: {} }) as { next_job_id: number };
      if (cfg.next_job_id !== 0) throw new Error("Verifier gas allowance needs review before changing an account already used by jobs");
      manifest.accounts.verifier = `verifier2.${manifest.root}`; save();
    }
  }
  const required = BigInt(wasm.length + 15_000) * 10n ** 19n + nearToYocto("0.5");
  for (const role of roles) {
    const id = manifest.accounts[role]!;
    const existing = await state(id);
    if (existing) {
      await verifyKey(id);
      if (role !== "escrow" && existing.balance.total < nearToYocto("0.6")) {
        const amount = nearToYocto("0.6") - existing.balance.total;
        if ((await account(manifest.root).getState()).balance.available < amount + nearToYocto("0.1")) throw new Error(`Fund ${manifest.root} with testnet gas before topping up ${role}`);
        receipt(`fund ${role} gas reserve`, await account(manifest.root).signAndSendTransaction({ receiverId: id, waitUntil: "FINAL", actions: [actions.transfer(amount)] }));
      }
      continue;
    }
    const amount = role === "escrow" ? required : nearToYocto("0.6");
    const available = (await account(manifest.root).getState()).balance.available;
    if (available < amount + nearToYocto("0.1")) throw new Error(`Fund ${manifest.root} with additional testnet NEAR before creating ${role}`);
    const key = localKey(id).getPublicKey();
    const methods = role === "verifier" ? ["release_verified_milestone"] : role === "relayer" ? ["record_deposit", "record_excess", "mark_payout_processed"] : null;
    const permission = methods ? actions.addFunctionCallAccessKey(key, manifest.accounts.escrow!, methods, nearToYocto("1")) : actions.addFullAccessKey(key);
    receipt(`create ${role}`, await account(manifest.root).signAndSendTransaction({ receiverId: id, waitUntil: "FINAL", actions: [actions.createAccount(), actions.transfer(amount), permission] }));
    await verifyKey(id);
  }
  const contractId = manifest.accounts.escrow!;
  const contract = account(contractId);
  const deployed = await contract.getState();
  if (deployed.codeHash === "11111111111111111111111111111111") {
    receipt("deploy and initialize escrow", await contract.signAndSendTransaction({ receiverId: contractId, waitUntil: "FINAL", actions: [
      actions.deployContract(wasm), actions.functionCall("new", { owner: manifest.root, relayer: manifest.accounts.relayer, mpc_contract: "v1.signer-prod.testnet", mpc_path: "nearportal-pr-v1" }, teraToGas("100")),
    ] }));
  } else if (deployed.codeHash !== codeHash) throw new Error("Existing managed contract differs from this WASM; refusing an implicit upgrade");
  if ((await contract.getState()).codeHash !== codeHash) throw new Error("Deployed code hash mismatch");
  const config = await provider.callFunction({ contractId, method: "get_config", args: {} }) as { owner: string; relayer: string; mpc_contract: string };
  if (config.owner !== manifest.root || config.relayer !== manifest.accounts.relayer || config.mpc_contract !== "v1.signer-prod.testnet") throw new Error("Deployed contract configuration mismatch");
  await provider.callFunction({ contractId, method: "get_release_policy", args: { job_id: 0 } });
  manifest.codeHash = codeHash; manifest.initialized = true; save(); updateEnvironment();
  console.log(`Verified testnet deployment: ${contractId}`);
  console.log(`Code hash: ${codeHash}`);
  console.log("Restricted verifier and relayer keys saved in data/sandbox/keys. No private key was printed.");
  console.log(".env.sandbox updated. Monerium credentials are still required; the running app has not switched payment modes.");
} catch (error) {
  updateEnvironment();
  console.error(error instanceof Error ? error.message.slice(0, 400) : "Sandbox deployment failed");
  process.exitCode = 1;
}
