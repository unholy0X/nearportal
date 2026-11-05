// Configuration from environment variables (see .env.example). Secrets are never logged.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  moneriumApi: string;
  moneriumClientId: string;
  moneriumClientSecret: string;
  chain: string;
  nearRpc: string;
  network: "testnet" | "mainnet";
  contractId: string;
  relayerAccountId: string;
  relayerPrivateKey: string;
  stateFile: string;
  pollSeconds: number;
}

/** Loads KEY=VALUE pairs from a .env file into process.env without overriding existing values. */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i < 1 || line.trimStart().startsWith("#")) continue;
    const key = line.slice(0, i).trim();
    process.env[key] ??= line.slice(i + 1).trim();
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

/** Reads the relayer key from the near-cli legacy keychain if not given explicitly. */
function relayerKey(network: string, accountId: string): string {
  if (process.env.RELAYER_PRIVATE_KEY) return process.env.RELAYER_PRIVATE_KEY;
  const file = join(homedir(), ".near-credentials", network, `${accountId}.json`);
  const key = JSON.parse(readFileSync(file, "utf8")).private_key as string | undefined;
  if (!key) throw new Error(`No private_key in ${file}`);
  return key;
}

export function loadConfig(envFile = process.env.ENV_FILE ?? ".env"): Config {
  loadDotEnv(envFile);
  const network = (process.env.NEAR_NETWORK ?? "testnet") as Config["network"];
  const relayerAccountId = required("RELAYER_ACCOUNT_ID");
  return {
    moneriumApi: process.env.MONERIUM_API ?? "https://api.monerium.dev",
    moneriumClientId: required("MONERIUM_CLIENT_ID"),
    moneriumClientSecret: required("MONERIUM_CLIENT_SECRET"),
    chain: process.env.MONERIUM_CHAIN ?? "basesepolia",
    nearRpc: process.env.NEAR_RPC ?? (network === "mainnet" ? "https://free.rpc.fastnear.com,https://rpc.mainnet.near.org" : "https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://archival-rpc.testnet.fastnear.com,https://rpc.testnet.near.org"),
    network,
    contractId: required("ESCROW_CONTRACT_ID"),
    relayerAccountId,
    relayerPrivateKey: relayerKey(network, relayerAccountId),
    stateFile: process.env.STATE_FILE ?? "data/state.json",
    pollSeconds: Number(process.env.POLL_SECONDS ?? "15"),
  };
}
