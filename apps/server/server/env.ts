// Loads .env (path in ENV_FILE) and the near-cli keychain keys of the demo accounts.
// Demo only: in production each party signs with its own passkey, never with server-held keys.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i < 1 || line.trimStart().startsWith("#")) continue;
    process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim();
  }
}
loadDotEnv(process.env.ENV_FILE ?? ".env");

export const env = {
  network: (process.env.NEAR_NETWORK ?? "testnet") as "testnet" | "mainnet",
  nearRpc: process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://archival-rpc.testnet.fastnear.com,https://rpc.testnet.near.org", // comma-separated, failover in order
  contractId: process.env.ESCROW_CONTRACT_ID ?? "escrow.nearportal-test.testnet",
  mpcContract: process.env.MPC_CONTRACT ?? "v1.signer-prod.testnet",
  artisan: process.env.ARTISAN_ACCOUNT_ID ?? "nearportal-test.testnet",
  client: process.env.CLIENT_ACCOUNT_ID ?? "client.nearportal-test.testnet",
  mediator: process.env.MEDIATOR_ACCOUNT_ID ?? "mediator.nearportal-test.testnet",
  relayer: process.env.RELAYER_ACCOUNT_ID ?? "nearportal-test.testnet",
  // Monerium sandbox example recipient; set ARTISAN_IBAN to an IBAN from your own Monerium sandbox account.
  artisanIban: process.env.ARTISAN_IBAN ?? "FR7630006000011234567890189",
  artisanFirstName: process.env.ARTISAN_FIRST_NAME ?? "Marc",
  artisanLastName: process.env.ARTISAN_LAST_NAME ?? "Durand",
  monerium: {
    api: process.env.MONERIUM_API ?? "https://api.monerium.dev",
    clientId: process.env.MONERIUM_CLIENT_ID ?? "",
    clientSecret: process.env.MONERIUM_CLIENT_SECRET ?? "",
    chain: process.env.MONERIUM_CHAIN ?? "basesepolia",
  },
  port: Number(process.env.PORT ?? "8787"),
  dataDir: process.env.DATA_DIR ?? "data",
  credentialsDir: process.env.NEAR_CREDENTIALS_DIR ? resolve(process.env.NEAR_CREDENTIALS_DIR) : join(homedir(), ".near-credentials", process.env.NEAR_NETWORK ?? "testnet"),
};

/** The relayer signs with its own function-call key on the same account when one is present, so its
 * nonces never collide with the provider's transactions sent by this server. */
export function relayerKey(accountId: string): string {
  const file = join(env.credentialsDir, `${accountId}.relayer-key.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).private_key as string;
  return keyFor(accountId);
}

export function keyFor(accountId: string): string {
  let file = join(env.credentialsDir, `${accountId}.json`);
  if (!existsSync(file) && [process.env.CRYPTO_ESCROW_CONTRACT_ID,process.env.CRYPTO_CLIENT_ACCOUNT_ID,process.env.CRYPTO_VERIFIER_ACCOUNT_ID,process.env.CRYPTO_LEGACY_VERIFIER_ACCOUNT_ID,process.env.CRYPTO_RELAYER_ACCOUNT_ID].includes(accountId)) file=join(env.dataDir,"crypto-keys",`${accountId}.json`);
  const key = JSON.parse(readFileSync(file, "utf8")).private_key as string | undefined;
  if (!key) throw new Error(`No key for ${accountId}`);
  return key;
}
