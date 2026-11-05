// Durable state of the agent (MCP) API: device authorization requests, bearer credentials (hash
// only), reusable wallet verifications, idempotency records, batch preparations and batches.
// Additive tables only; nothing here is read by the payment workers.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const SCOPES = ["read", "contribute", "create", "release"] as const;
export type AgentScope = (typeof SCOPES)[number];
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // RFC 8628 §6.1: no vowels, no ambiguous glyphs
export const DEVICE_TTL_MS = 10 * 60_000;
export const DEVICE_INTERVAL_S = 5;
export const WALLET_CHALLENGE_TTL_MS = 10 * 60_000;
const days = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return (Number.isSafeInteger(v) && v > 0 && v <= 365 ? v : fallback) * 86_400_000;
};
export const tokenTtlMs = () => days("AGENT_TOKEN_TTL_DAYS", 30);
export const walletTtlMs = () => days("AGENT_WALLET_TTL_DAYS", 90);

export interface DeviceRequest {
  id: string;
  user_code: string;
  client_name: string;
  scopes: string;
  expected_login: string | null;
  status: "pending" | "approved" | "denied" | "consumed";
  user_id: number | null;
  approved_scopes: string | null;
  created: number;
  expires: number;
  last_poll: number;
  interval_s: number;
}
export interface TokenRow {
  id: string;
  user_id: number;
  scopes: string;
  client_name: string;
  created: number;
  expires: number;
  revoked_at: number | null;
  last_used: number;
}
export interface WalletRow {
  user_id: number;
  network: string;
  address: string;
  verified_at: number;
  expires: number;
  revoked_at: number | null;
}
export interface WalletRequest {
  id: string;
  user_id: number;
  network: string;
  address: string;
  message: string;
  status: "pending" | "verified" | "expired";
  created: number;
  expires: number;
}

export class AgentStore {
  constructor(readonly db: DatabaseSync, private readonly now: () => number = () => Date.now()) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_device_requests(id TEXT PRIMARY KEY, device_hash TEXT NOT NULL UNIQUE, user_code TEXT NOT NULL UNIQUE,
        client_name TEXT NOT NULL, scopes TEXT NOT NULL, expected_login TEXT, status TEXT NOT NULL, user_id INTEGER, approved_scopes TEXT,
        created INTEGER NOT NULL, expires INTEGER NOT NULL, last_poll INTEGER NOT NULL DEFAULT 0, interval_s INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_tokens(id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL, scopes TEXT NOT NULL,
        client_name TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked_at INTEGER, last_used INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS agent_tokens_user ON agent_tokens(user_id);
      CREATE TABLE IF NOT EXISTS agent_wallets(user_id INTEGER NOT NULL, network TEXT NOT NULL, address TEXT NOT NULL, verified_at INTEGER NOT NULL,
        expires INTEGER NOT NULL, revoked_at INTEGER, proof_digest TEXT NOT NULL, PRIMARY KEY(user_id, network, address));
      CREATE TABLE IF NOT EXISTS agent_wallet_requests(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, network TEXT NOT NULL, address TEXT NOT NULL,
        nonce_hash TEXT NOT NULL UNIQUE, message TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_idempotency(user_id INTEGER NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
        result TEXT, created INTEGER NOT NULL, PRIMARY KEY(user_id, operation, key));
      CREATE TABLE IF NOT EXISTS agent_preparations(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL,
        created INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_batches(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL,
        created INTEGER NOT NULL, updated INTEGER NOT NULL, UNIQUE(user_id, key));
      CREATE TABLE IF NOT EXISTS portal_schema_versions(name TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at TEXT NOT NULL);
      INSERT OR IGNORE INTO portal_schema_versions VALUES('agent-api', 1, datetime('now'));`);
  }
  transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---------------- Device authorization ----------------
  startDevice(clientName: string, scopes: AgentScope[], expectedLogin: string | null) {
    const deviceCode = "npd_" + randomBytes(32).toString("base64url");
    const t = this.now();
    this.db.prepare("DELETE FROM agent_device_requests WHERE expires<?").run(t - 86_400_000);
    for (let attempt = 0; ; attempt++) {
      const bytes = randomBytes(8);
      const raw = [...bytes].map((b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join("");
      const userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      try {
        this.db.prepare("INSERT INTO agent_device_requests(id,device_hash,user_code,client_name,scopes,expected_login,status,created,expires,interval_s) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(randomUUID(), sha256(deviceCode), userCode, clientName, scopes.join(" "), expectedLogin, "pending", t, t + DEVICE_TTL_MS, DEVICE_INTERVAL_S);
        return { deviceCode, userCode, expiresAt: t + DEVICE_TTL_MS, interval: DEVICE_INTERVAL_S };
      } catch (error) {
        if (attempt > 4) throw error;
      }
    }
  }
  deviceByUserCode(userCode: string) {
    return this.db.prepare("SELECT * FROM agent_device_requests WHERE user_code=?").get(userCode) as DeviceRequest | undefined;
  }
  deviceByCode(deviceCode: string) {
    return this.db.prepare("SELECT * FROM agent_device_requests WHERE device_hash=?").get(sha256(deviceCode)) as DeviceRequest | undefined;
  }
  /** Only a pending, unexpired request can be decided, once; the deciding session's user is bound. */
  decide(userCode: string, userId: number, login: string, decision: "approve" | "deny", scopes: AgentScope[]) {
    return this.transaction(() => {
      const r = this.deviceByUserCode(userCode);
      if (!r) throw new AgentError("not_found", "Unknown connection code. Check the code shown in your terminal.");
      if (r.expires < this.now()) throw new AgentError("challenge_expired", "This connection request expired. Start a new login from the terminal.");
      if (r.status !== "pending") throw new AgentError("challenge_used", "This connection request was already decided.");
      if (r.expected_login && r.expected_login.toLowerCase() !== login.toLowerCase())
        throw new AgentError("wrong_account", `This request is reserved for @${r.expected_login}. Sign in with that GitHub account.`);
      const requested = r.scopes.split(" ");
      if (decision === "approve") {
        if (!scopes.length || scopes.some((s) => !requested.includes(s))) throw new AgentError("invalid_input", "Approve a subset of the requested permissions.");
        if (!scopes.includes("read")) throw new AgentError("invalid_input", "The read permission is required.");
      }
      this.db.prepare("UPDATE agent_device_requests SET status=?, user_id=?, approved_scopes=? WHERE id=? AND status='pending'")
        .run(decision === "approve" ? "approved" : "denied", userId, decision === "approve" ? scopes.join(" ") : null, r.id);
      return { ...r, status: decision === "approve" ? "approved" : "denied" };
    });
  }
  /** Polling never approves. It returns the token exactly once, after a human approval. */
  pollDevice(deviceCode: string): { status: "pending" | "slow_down" | "denied" | "expired"; interval: number } | { status: "approved"; token: string; row: TokenRow } {
    return this.transaction(() => {
      const r = this.deviceByCode(deviceCode);
      const t = this.now();
      if (!r || r.status === "consumed") throw new AgentError("challenge_used", "Unknown or already used device code. Start a new login.");
      if (r.expires < t) return { status: "expired" as const, interval: r.interval_s };
      if (r.status === "denied") return { status: "denied" as const, interval: r.interval_s };
      if (r.status === "pending") {
        const tooFast = t - r.last_poll < (r.interval_s - 1) * 1000;
        const interval = tooFast ? Math.min(60, r.interval_s + 5) : r.interval_s;
        this.db.prepare("UPDATE agent_device_requests SET last_poll=?, interval_s=? WHERE id=?").run(t, interval, r.id);
        return { status: tooFast ? ("slow_down" as const) : ("pending" as const), interval };
      }
      const token = "npa_" + randomBytes(32).toString("base64url");
      const row: TokenRow = { id: randomUUID(), user_id: r.user_id!, scopes: r.approved_scopes!, client_name: r.client_name, created: t, expires: t + tokenTtlMs(), revoked_at: null, last_used: 0 };
      this.db.prepare("INSERT INTO agent_tokens(id,hash,user_id,scopes,client_name,created,expires) VALUES(?,?,?,?,?,?,?)").run(row.id, sha256(token), row.user_id, row.scopes, row.client_name, row.created, row.expires);
      this.db.prepare("UPDATE agent_device_requests SET status='consumed' WHERE id=?").run(r.id);
      return { status: "approved" as const, token, row };
    });
  }

  // ---------------- Bearer credentials ----------------
  tokenFor(token: string) {
    return this.db.prepare("SELECT id,user_id,scopes,client_name,created,expires,revoked_at,last_used FROM agent_tokens WHERE hash=?").get(sha256(token)) as TokenRow | undefined;
  }
  touch(id: string) {
    const t = this.now();
    this.db.prepare("UPDATE agent_tokens SET last_used=? WHERE id=? AND last_used<?").run(t, id, t - 60_000);
  }
  tokens(userId: number) {
    return this.db.prepare("SELECT id,user_id,scopes,client_name,created,expires,revoked_at,last_used FROM agent_tokens WHERE user_id=? ORDER BY created DESC LIMIT 50").all(userId) as unknown as TokenRow[];
  }
  revoke(userId: number, id: string) {
    return Number(this.db.prepare("UPDATE agent_tokens SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL").run(this.now(), id, userId).changes) > 0;
  }

  // ---------------- Reusable wallet verification ----------------
  walletRequest(userId: number, network: string, address: string, message: (nonce: string, expires: number) => string) {
    const nonce = randomBytes(24).toString("hex"), t = this.now(), expires = t + WALLET_CHALLENGE_TTL_MS;
    const id = randomUUID();
    const text = message(nonce, expires);
    this.db.prepare("DELETE FROM agent_wallet_requests WHERE expires<?").run(t - 86_400_000);
    this.db.prepare("INSERT INTO agent_wallet_requests VALUES(?,?,?,?,?,?,?,?,?)").run(id, userId, network, address, sha256(nonce), text, "pending", t, expires);
    return this.walletRequestById(id)!;
  }
  walletRequestById(id: string) {
    const r = this.db.prepare("SELECT id,user_id,network,address,message,status,created,expires FROM agent_wallet_requests WHERE id=?").get(id) as WalletRequest | undefined;
    if (r && r.status === "pending" && r.expires < this.now()) r.status = "expired";
    return r;
  }
  /** Consume the single-use challenge and record the durable verification, atomically. */
  completeWallet(id: string, userId: number, proofDigest: string) {
    return this.transaction(() => {
      const r = this.walletRequestById(id);
      if (!r || r.user_id !== userId) throw new AgentError("not_found", "Unknown wallet verification request for this account.");
      if (r.status === "verified") throw new AgentError("challenge_used", "This wallet challenge was already used.");
      if (r.status !== "pending") throw new AgentError("challenge_expired", "This wallet challenge expired. Start a new verification.");
      const changed = this.db.prepare("UPDATE agent_wallet_requests SET status='verified' WHERE id=? AND status='pending'").run(id).changes;
      if (!Number(changed)) throw new AgentError("challenge_used", "This wallet challenge was already used.");
      const t = this.now();
      this.db.prepare("INSERT INTO agent_wallets VALUES(?,?,?,?,?,NULL,?) ON CONFLICT(user_id,network,address) DO UPDATE SET verified_at=excluded.verified_at, expires=excluded.expires, revoked_at=NULL, proof_digest=excluded.proof_digest")
        .run(userId, r.network, r.address, t, t + walletTtlMs(), proofDigest);
      return this.wallet(userId, r.network, r.address)!;
    });
  }
  wallet(userId: number, network: string, address: string) {
    return this.db.prepare("SELECT user_id,network,address,verified_at,expires,revoked_at FROM agent_wallets WHERE user_id=? AND network=? AND address=?").get(userId, network, address) as WalletRow | undefined;
  }
  activeWallet(userId: number, network: string, address: string) {
    const w = this.wallet(userId, network, address);
    return w && !w.revoked_at && w.expires > this.now() ? w : undefined;
  }
  wallets(userId: number) {
    return this.db.prepare("SELECT user_id,network,address,verified_at,expires,revoked_at FROM agent_wallets WHERE user_id=? ORDER BY verified_at DESC LIMIT 20").all(userId) as unknown as WalletRow[];
  }
  revokeWallet(userId: number, network: string, address: string) {
    return Number(this.db.prepare("UPDATE agent_wallets SET revoked_at=? WHERE user_id=? AND network=? AND address=? AND revoked_at IS NULL").run(this.now(), userId, network, address).changes) > 0;
  }

  // ---------------- Idempotency ----------------
  /** Returns the stored record for (user, operation, key); a different request hash is a conflict. */
  idempotency(userId: number, operation: string, key: string, requestHash: string) {
    const row = this.db.prepare("SELECT request_hash,result FROM agent_idempotency WHERE user_id=? AND operation=? AND key=?").get(userId, operation, key) as { request_hash: string; result: string | null } | undefined;
    if (row && row.request_hash !== requestHash) throw new AgentError("idempotency_conflict", "This idempotency key was already used with different parameters. Use a new key or the original parameters.");
    if (!row) this.db.prepare("INSERT OR IGNORE INTO agent_idempotency VALUES(?,?,?,?,NULL,?)").run(userId, operation, key, requestHash, this.now());
    return row?.result ? JSON.parse(row.result) : null;
  }
  remember(userId: number, operation: string, key: string, result: unknown) {
    this.db.prepare("UPDATE agent_idempotency SET result=? WHERE user_id=? AND operation=? AND key=?").run(JSON.stringify(result), userId, operation, key);
  }

  // ---------------- Preparations and batches ----------------
  savePreparation(userId: number, digest: string, body: unknown, ttlMs = 3_600_000) {
    const id = "prep_" + sha256(`${userId}:${digest}`).slice(0, 24), t = this.now();
    this.db.prepare("INSERT INTO agent_preparations VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, created=excluded.created, expires=excluded.expires").run(id, userId, digest, JSON.stringify(body), t, t + ttlMs);
    return { id, expiresAt: t + ttlMs };
  }
  preparation<T>(userId: number, id: string) {
    const r = this.db.prepare("SELECT digest,body,expires FROM agent_preparations WHERE id=? AND user_id=?").get(id, userId) as { digest: string; body: string; expires: number } | undefined;
    if (!r) return null;
    return { digest: r.digest, body: JSON.parse(r.body) as T, expired: r.expires < this.now() };
  }
  batchByKey<T>(userId: number, key: string) {
    const r = this.db.prepare("SELECT id,digest,body FROM agent_batches WHERE user_id=? AND key=?").get(userId, key) as { id: string; digest: string; body: string } | undefined;
    return r ? { id: r.id, digest: r.digest, body: JSON.parse(r.body) as T } : null;
  }
  batch<T>(userId: number, id: string) {
    const r = this.db.prepare("SELECT id,key,digest,body FROM agent_batches WHERE id=? AND user_id=?").get(id, userId) as { id: string; key: string; digest: string; body: string } | undefined;
    return r ? { id: r.id, key: r.key, digest: r.digest, body: JSON.parse(r.body) as T } : null;
  }
  createBatch(userId: number, key: string, digest: string, body: unknown) {
    const id = "batch_" + sha256(`${userId}:${key}`).slice(0, 24), t = this.now();
    this.db.prepare("INSERT OR IGNORE INTO agent_batches VALUES(?,?,?,?,?,?,?)").run(id, userId, key, digest, JSON.stringify(body), t, t);
    return id;
  }
  saveBatch(id: string, body: unknown) {
    this.db.prepare("UPDATE agent_batches SET body=?, updated=? WHERE id=?").run(JSON.stringify(body), this.now(), id);
  }
}

/** Stable, documented error codes for agent clients. */
export type AgentErrorCode =
  | "not_authenticated" | "credential_expired" | "credential_revoked" | "insufficient_scope"
  | "wallet_not_verified" | "wrong_network" | "repository_access_required" | "bounty_not_funded"
  | "bounty_already_assigned" | "agreement_changed" | "wrong_generation" | "deadline_passed"
  | "invalid_pull_request" | "submission_pending_confirmation" | "assignment_processing" | "rate_limited"
  | "provider_unavailable" | "outcome_uncertain" | "idempotency_conflict" | "invalid_input" | "not_found"
  | "capability_disabled" | "conflict" | "forbidden" | "challenge_expired" | "challenge_used" | "wrong_account"
  | "not_supported" | "invalid_signature";
const STATUS: Record<AgentErrorCode, number> = {
  not_authenticated: 401, credential_expired: 401, credential_revoked: 401, insufficient_scope: 403, wallet_not_verified: 403,
  wrong_network: 400, repository_access_required: 403, bounty_not_funded: 409, bounty_already_assigned: 409, agreement_changed: 409,
  wrong_generation: 409, deadline_passed: 409, invalid_pull_request: 422, submission_pending_confirmation: 409, assignment_processing: 409,
  rate_limited: 429, provider_unavailable: 503, outcome_uncertain: 504, idempotency_conflict: 409, invalid_input: 400, not_found: 404,
  capability_disabled: 409, conflict: 409, forbidden: 403, challenge_expired: 410, challenge_used: 409, wrong_account: 403,
  not_supported: 400, invalid_signature: 400,
};
export class AgentError extends Error {
  readonly status: number;
  constructor(readonly code: AgentErrorCode, message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "AgentError";
    this.status = STATUS[code];
  }
}
/** Map messages of the shared engine and services (the single source of the rules) to stable codes. */
export function classify(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  const m = error instanceof Error ? error.message : String(error);
  const rules: [RegExp, AgentErrorCode][] = [
    [/not funded|is not ready|still preparing/i, "bounty_not_funded"],
    [/already holds this assignment|not available for a direct claim|already been claimed|already claimed/i, "bounty_already_assigned"],
    [/Terms changed|agreement changed|Bounty changed|review it again/i, "agreement_changed"],
    [/does not belong to the current assignment|generation mismatch|Confirm which assignment/i, "wrong_generation"],
    [/deadline has passed/i, "deadline_passed"],
    [/still being confirmed/i, "assignment_processing"],
    [/Repository access|repository write access/i, "repository_access_required"],
    [/pull request|PR description|already linked to another PR|no changes/i, "invalid_pull_request"],
    [/not enabled|unavailable on this deployment|await contract deployment|awaiting deployment/i, "capability_disabled"],
    [/changed while the update was in progress|stale/i, "conflict"],
    [/not found/i, "not_found"],
    [/owner cannot claim|client cannot claim|Only (the|a) /i, "forbidden"],
  ];
  for (const [pattern, code] of rules) if (pattern.test(m)) return new AgentError(code, m);
  return new AgentError("invalid_input", m);
}
