// Structured JSON logs with correlation IDs. Values that look like credentials, IBANs or bearer
// tokens are redacted before they are written, so a careless call site cannot leak them.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const context = new AsyncLocalStorage<{ requestId: string }>();
const SECRET_KEY = /token|secret|password|authorization|cookie|csrf|iban|private|key|signature/i;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g;
const BEARER = /\b(?:Bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const GH_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const NEAR_KEY = /\bed25519:[1-9A-HJ-NP-Za-km-z]{32,}\b/g;
const HEX_KEY = /\b0x[a-fA-F0-9]{64}\b/g;
const AGENT_TOKEN = /\bnp[ad]_[A-Za-z0-9_-]{20,}/g;

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string")
    return value.replace(GH_TOKEN, "[redacted-token]").replace(BEARER, "[redacted-bearer]").replace(NEAR_KEY, "[redacted-key]").replace(HEX_KEY, "[redacted-hex]").replace(AGENT_TOKEN, "[redacted-agent-token]").replace(IBAN, (m) => `${m.slice(0, 4)}…[redacted]`);
  if (!value || typeof value !== "object" || depth > 4) return value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  return out;
}

export function withRequestId<T>(requestId: string | undefined, run: () => T): T {
  const id = requestId && /^[A-Za-z0-9._-]{8,64}$/.test(requestId) ? requestId : randomUUID();
  return context.run({ requestId: id }, run);
}
export const requestId = () => context.getStore()?.requestId;

type Level = "debug" | "info" | "warn" | "error";
const quiet = () => process.env.LOG_LEVEL === "silent" || (process.env.NODE_TEST_CONTEXT !== undefined && process.env.LOG_LEVEL === undefined);
export function log(level: Level, event: string, fields: Record<string, unknown> = {}) {
  if (quiet() || (level === "debug" && process.env.LOG_LEVEL !== "debug")) return;
  const line = JSON.stringify({ at: new Date().toISOString(), level, event, requestId: requestId(), ...(redact(fields) as object) });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}
