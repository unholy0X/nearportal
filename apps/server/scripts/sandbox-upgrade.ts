// Upgrade only the existing isolated testnet deployment; preserve and verify all job state.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  Account,
  actions,
  KeyPair,
  nearToYocto,
  type KeyPairString,
} from "near-api-js";
import bs58 from "bs58";
import { rpcProvider } from "../../../services/relayer/src/near.ts";
process.env.ENV_FILE ??= ".env.sandbox";
const { env, keyFor } = await import("../server/env.ts");
if (
  env.network !== "testnet" ||
  !env.contractId.includes(".testnet") ||
  env.monerium.api !== "https://api.monerium.dev"
)
  throw new Error("Sandbox upgrade only");
const manifestPath = resolve("data/sandbox/deployment.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.accounts.escrow !== env.contractId)
  throw new Error("Deployment account mismatch");
const provider = rpcProvider(env.nearRpc);
const account = (id: string) =>
  new Account(id, provider, keyFor(id) as KeyPairString);
const contract = account(env.contractId);
const config = (await provider.callFunction({
  contractId: env.contractId,
  method: "get_config",
  args: {},
})) as { next_job_id: number; next_payout_id: number };
const jobs = [];
for (let id = 0; id < config.next_job_id; id++)
  jobs.push(
    await provider.callFunction({
      contractId: env.contractId,
      method: "get_job",
      args: { job_id: id },
    }),
  );
for (let id = 0; id < config.next_payout_id; id++) {
  const p = (await provider.callFunction({
    contractId: env.contractId,
    method: "get_payout",
    args: { payout_id: id },
  })) as { state: string };
  if (p.state !== "Processed")
    throw new Error("Resolve pending payouts before upgrading");
}
const wasm = readFileSync(
  resolve(
    process.env.ESCROW_WASM ?? "../../contracts/escrow/target/wasm32-unknown-unknown/release/nearportal_escrow.wasm",
  ),
);
const codeHash = bs58.encode(createHash("sha256").update(wasm).digest());
const current = await contract.getState();
if (current.codeHash !== codeHash) {
  const tx = await contract.signAndSendTransaction({
    receiverId: env.contractId,
    actions: [actions.deployContract(wasm)],
    waitUntil: "FINAL",
  });
  manifest.transactions.push({
    action: "upgrade open-bounty mandate",
    hash: tx.transaction.hash,
  });
  console.log("Testnet upgrade transaction: " + tx.transaction.hash);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
}
for (let id = 0; id < jobs.length; id++) {
  const after = await provider.callFunction({
    contractId: env.contractId,
    method: "get_job",
    args: { job_id: id },
  });
  if (JSON.stringify(after) !== JSON.stringify(jobs[id]))
    throw new Error("Existing job state changed during upgrade");
}
await provider.callFunction({
  contractId: env.contractId,
  method: "get_open_bounty_mandate",
  args: { job_id: 0 },
});
const verifier = `verifier3.${manifest.root}`;
const file = join(env.credentialsDir, `${verifier}.json`);
if (!existsSync(file)) {
  const pair = KeyPair.fromRandom("ed25519");
  writeFileSync(
    file,
    JSON.stringify({
      account_id: verifier,
      public_key: pair.getPublicKey().toString(),
      private_key: pair.toString(),
    }),
    { mode: 0o600, flag: "wx" },
  );
}
const pair = KeyPair.fromString(keyFor(verifier) as KeyPairString);
let exists = true;
try {
  await new Account(verifier, provider).getState();
} catch (e) {
  if (/UNKNOWN_ACCOUNT|does not exist/i.test(String(e))) exists = false;
  else throw e;
}
if (!exists) {
  const tx = await account(manifest.root).signAndSendTransaction({
    receiverId: verifier,
    actions: [
      actions.createAccount(),
      actions.transfer(nearToYocto("0.5")),
      actions.addFunctionCallAccessKey(
        pair.getPublicKey(),
        env.contractId,
        ["release_verified_milestone", "bind_bounty_submission"],
        nearToYocto("0.5"),
      ),
    ],
    waitUntil: "FINAL",
  });
  manifest.transactions.push({
    action: "create open-bounty verifier",
    hash: tx.transaction.hash,
  });
  console.log("Scoped verifier transaction: " + tx.transaction.hash);
}
const access = await new Account(verifier, provider).getAccessKey(
  pair.getPublicKey(),
);
if (
  typeof access.permission !== "object" ||
  !access.permission.FunctionCall.method_names.includes(
    "bind_bounty_submission",
  )
)
  throw new Error("Verifier key scope mismatch");
let dotenv = readFileSync(".env.sandbox", "utf8");
dotenv = dotenv.replace(
  /^GITHUB_VERIFIER_ACCOUNT_ID=.*$/m,
  `GITHUB_VERIFIER_ACCOUNT_ID=${verifier}`,
);
dotenv = dotenv.replace(/^PORTAL_OPEN_BOUNTY_ENABLED=.*\n?/m, "");
dotenv += "\nPORTAL_OPEN_BOUNTY_ENABLED=1\n";
writeFileSync(".env.sandbox", dotenv, { mode: 0o600 });
manifest.codeHash = codeHash;
manifest.accounts.openBountyVerifier = verifier;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(
  `Verified ${jobs.length} existing jobs unchanged. Open-bounty mandate available. No money moved.`,
);
