// Startup validation for a hosted deployment. Refuses to start with a configuration that would
// generate localhost links, split the origin (breaking cookies/CSRF), or trust spoofable headers.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "./log.ts";
import { portalUserAllowed } from "./pilot-access.ts";

export interface Hosted {
  hosted: boolean;
  https: boolean;
  publicOrigin: string;
  siteDir: string | null;
  warnings: string[];
}

export function hostedConfig(env: NodeJS.ProcessEnv = process.env): Hosted {
  const hosted = env.NEARPORTAL_HOSTED === "1" || env.NODE_ENV === "production";
  const origin = env.APP_ORIGIN ?? "http://127.0.0.1:8787";
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("APP_ORIGIN must be an absolute origin such as https://nearportal.com");
  }
  const siteDir = env.SITE_DIR ? resolve(env.SITE_DIR) : null;
  if (siteDir && !existsSync(resolve(siteDir, "site.mjs"))) throw new Error("SITE_DIR must point to the built landing (missing site.mjs)");
  const warnings: string[] = [];
  if (hosted) {
    const problems: string[] = [];
    if (url.protocol !== "https:") problems.push("APP_ORIGIN must use https");
    if (url.pathname !== "/" || url.search || url.hash || url.username) problems.push("APP_ORIGIN must be a bare origin");
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) problems.push("APP_ORIGIN must be the public hostname, not localhost");
    if (env.PORTAL_FRONTEND_ORIGIN && new URL(env.PORTAL_FRONTEND_ORIGIN).origin !== url.origin) problems.push("PORTAL_FRONTEND_ORIGIN must be unset or equal to APP_ORIGIN (single public origin)");
    if (!siteDir) problems.push("SITE_DIR (built landing) is required so the landing and workspace share the public origin");
    if (env.PORTAL_LOCAL_PREVIEW === "1") problems.push("PORTAL_LOCAL_PREVIEW must be off");
    if (env.GITHUB_USE_CLI === "1") problems.push("GITHUB_USE_CLI must be off (no local CLI credentials on a host)");
    if (!env.PORTAL_ENCRYPTION_KEY) problems.push("PORTAL_ENCRYPTION_KEY is required (persistent, stored outside the data volume)");
    if (!env.TASK_ADMIN_TOKEN) problems.push("TASK_ADMIN_TOKEN is required");
    if (env.GITHUB_API_BASE && env.GITHUB_API_BASE !== "https://api.github.com") problems.push("GITHUB_API_BASE is a test-only override");
    if (env.NEAR_NETWORK && env.NEAR_NETWORK !== "testnet") problems.push("This build is a testnet demo: NEAR_NETWORK must be testnet");
    if (env.NEARPORTAL_USDC_PILOT === "1") {
      if (env.TASK_PAYMENT_MODE !== "sandbox" || env.TASK_BANK_ENABLED !== "0" || env.CRYPTO_USDC_ENABLED !== "1")
        problems.push("USDC pilot requires sandbox mode, CRYPTO_USDC_ENABLED=1 and TASK_BANK_ENABLED=0");
      if (!env.PORTAL_ALLOWED_GITHUB_IDS) problems.push('USDC pilot requires an explicit PORTAL_ALLOWED_GITHUB_IDS list or "*" for public access');
      else { try { portalUserAllowed(0, env.PORTAL_ALLOWED_GITHUB_IDS); } catch { problems.push("USDC pilot GitHub account list is invalid"); } }
    }
    if (problems.length) throw new Error(`Hosted configuration rejected:\n- ${problems.join("\n- ")}`);
    if (!env.TRUSTED_PROXIES) warnings.push("TRUSTED_PROXIES is unset: every client shares the proxy's IP for anonymous quotas");
    if (!env.GITHUB_WEBHOOK_SECRET) warnings.push("GITHUB_WEBHOOK_SECRET is unset: GitHub changes are picked up by polling only (higher API use)");
    if (!env.NEAR_RPC) warnings.push("NEAR_RPC is unset: falling back to public testnet RPC endpoints");
    for (const w of warnings) log("warn", "config.warning", { warning: w });
  }
  return { hosted, https: url.protocol === "https:", publicOrigin: url.origin, siteDir, warnings };
}
