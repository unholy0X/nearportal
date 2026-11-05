// READ-ONLY preflight for the fixed-deadline testnet scenarios. It never signs or sends a
// transaction and moves no funds. It reports, per rail:
// - deployed code hash, and whether it is in MARKET_VERIFIED_CODE_HASHES;
// - whether the deadline methods exist (absence = the extended contract is not deployed);
// - the verifier account's function-call key scopes (new methods must be explicitly allowed).
// Usage: ENV_FILE=.env.sandbox node --import tsx scripts/e2e/testnet-preflight.ts
import { readFileSync, existsSync } from "node:fs";

const file = process.env.ENV_FILE ?? ".env.sandbox";
const env: Record<string, string> = { ...process.env } as Record<string, string>;
if (existsSync(file)) for (const line of readFileSync(file, "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0 && !line.startsWith("#")) env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim();
}
if ((env.NEAR_NETWORK ?? "testnet") !== "testnet") throw new Error("Preflight is for NEAR testnet only");
const rpc = (env.NEAR_RPC ?? "https://rpc.testnet.near.org").split(",")[0]!.trim();
const query = async (params: Record<string, unknown>) => {
  const r = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "preflight", method: "query", params: { finality: "final", ...params } }), signal: AbortSignal.timeout(15_000) });
  return (await r.json()) as { result?: any; error?: any };
};
const view = async (account: string, method: string, args: unknown) => {
  const r = await query({ request_type: "call_function", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  const err = r.error ? JSON.stringify(r.error) : r.result?.error;
  return err ? { ok: false, missing: /MethodNotFound/.test(String(err)), error: String(err).slice(0, 140) } : { ok: true, missing: false };
};
const verified = (env.MARKET_VERIFIED_CODE_HASHES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const report: Record<string, unknown> = { network: "testnet", rpc: new URL(rpc).host, verifiedHashes: verified.length };
const rails = [
  { rail: "bank (Monerium sandbox)", contract: env.ESCROW_CONTRACT_ID, method: "get_bounty_market", args: { job_id: 0 }, needs: ["bind_market_assignment", "record_market_submission", "expire_market_assignment", "withdraw_market_assignment", "release_market_assignment"] },
  { rail: "USDC (Base Sepolia)", contract: env.CRYPTO_ESCROW_CONTRACT_ID, method: "get_crypto_market", args: { id: "00000000-0000-0000-0000-000000000000" }, needs: ["bind_crypto_assignment", "record_crypto_submission", "expire_crypto_assignment", "withdraw_crypto_assignment", "release_crypto_bounty"] },
];
const verifiers = [env.GITHUB_VERIFIER_ACCOUNT_ID, env.CRYPTO_VERIFIER_ACCOUNT_ID];
for (const [i, r] of rails.entries()) {
  if (!r.contract) { report[r.rail] = { configured: false }; continue; }
  const account = await query({ request_type: "view_account", account_id: r.contract });
  const codeHash = account.result?.code_hash ?? null;
  const probe = await view(r.contract, r.method, r.args);
  const verifier = verifiers[i];
  let scopes: string[] | null = null;
  if (verifier) {
    const keys = await query({ request_type: "view_access_key_list", account_id: verifier });
    scopes = (keys.result?.keys ?? []).flatMap((k: any) => k.access_key?.permission?.FunctionCall?.receiver_id === r.contract ? [k.access_key.permission.FunctionCall.method_names.length ? k.access_key.permission.FunctionCall.method_names.join(" ") : "(all methods)"] : []);
  }
  report[r.rail] = {
    contract: r.contract,
    codeHash,
    codeHashVerified: Boolean(codeHash && verified.includes(codeHash)),
    deadlineMethodsDeployed: probe.ok,
    verifierFunctionCallKeys: scopes,
    verifierKeyCoversNewMethods: scopes === null ? "unknown (no verifier configured)" : scopes.some((s) => s === "(all methods)" || r.needs.every((m) => s.split(" ").includes(m))),
  };
}
console.log(JSON.stringify(report, null, 2));
const selected = process.argv.includes("--usdc-only") ? rails.filter(r => r.rail.startsWith("USDC")) : rails;
const ready = selected.every((r) => (report[r.rail] as any)?.deadlineMethodsDeployed && (report[r.rail] as any)?.codeHashVerified && (report[r.rail] as any)?.verifierKeyCoversNewMethods === true);
console.log(ready ? "\nSelected rails: extended contract deployed, scoped and verified. Run the E2E runbook." : "\nNot ready: deploy the reviewed WASM on testnet, verify it, then add its code hash to MARKET_VERIFIED_CODE_HASHES. No transaction was sent.");
