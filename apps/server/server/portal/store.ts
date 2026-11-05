import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { bumpDataVersion } from "../ops/version.ts";

const REV = Symbol("revision");
export class StaleBountyError extends Error {
  constructor() {
    super("This bounty changed while the update was in progress. Refresh and try again.");
    this.name = "StaleBountyError";
  }
}
const withRev = (b: Bounty, rev: number) => {
  Object.defineProperty(b, REV, { value: rev, enumerable: false, writable: true, configurable: true });
  return b;
};
const parse = (r: { body: string; rev: number }) => withRev(JSON.parse(r.body) as Bounty, r.rev);

export interface Identity {
  id: number;
  login: string;
  avatar: string;
  name: string;
  local?: boolean;
}
export interface User extends Identity {
  token: string;
  oauth?: { clientId: string; expiresAt: number; refreshToken: string; refreshExpiresAt: number; refreshUncertain?: boolean };
  payout?: Record<string, string>;
  bank?: { clientId: string; clientSecret: string };
  createdAt: string;
}
export interface Bounty {
  paymentRail?: "base-usdc";
  marketTerms?: import("./market.ts").MarketTerms;
  id: string;
  code: string;
  ownerId: number;
  owner: string;
  repository: string;
  private: boolean;
  title: string;
  description: string;
  criteria: string[];
  amountCents: number;
  branch: string;
  checkName: string;
  checkAppId: number;
  workflowPath: string;
  protectedPaths: string;
  taskId: string | null;
  issueNumber: number | null;
  issueUrl: string | null;
  status:
    | "Draft"
    | "Preparing"
    | "AwaitingFunding"
    | "Open"
    | "Claimed"
    | "InReview"
    | "Releasing"
    | "Paid"
    | "Blocked"
    | "NeedsAttention";
  published: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AccessRequest {
  bountyId: string;
  userId: number;
  login: string;
  status: "requested" | "invited" | "accepted";
  createdAt: string;
}
export class PortalStore {
  private key: Buffer;
  constructor(
    readonly db: DatabaseSync,
    directory: string,
    key?: Buffer,
  ) {
    if (key) this.key = key;
    else if (process.env.PORTAL_ENCRYPTION_KEY !== undefined)
      this.key = Buffer.from(process.env.PORTAL_ENCRYPTION_KEY, "base64");
    else {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, "portal-encryption.key");
      if (!existsSync(path))
        writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
      this.key = readFileSync(path);
    }
    if (this.key.length !== 32)
      throw new Error("Portal encryption key must be 32 bytes");
    db.exec(`CREATE TABLE IF NOT EXISTS portal_users(id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS portal_sessions(hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS portal_oauth(hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS portal_bounties(id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS portal_jobs(id TEXT PRIMARY KEY, bounty_id TEXT NOT NULL, kind TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS portal_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    db.exec(`CREATE TABLE IF NOT EXISTS portal_access_requests(
      bounty_id TEXT NOT NULL, user_id INTEGER NOT NULL, login TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested', created_at TEXT NOT NULL,
      PRIMARY KEY(bounty_id,user_id));`);
    const columns = (this.db.prepare("PRAGMA table_info(portal_bounties)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("rev")) db.exec("ALTER TABLE portal_bounties ADD COLUMN rev INTEGER NOT NULL DEFAULT 0");
    // Indexed projections for paginated and per-user queries (kept in sync on every save).
    for (const [name, type] of [["owner_id", "INTEGER"], ["published", "INTEGER"], ["created_at", "TEXT"], ["task_id", "TEXT"]] as const)
      if (!columns.includes(name)) db.exec(`ALTER TABLE portal_bounties ADD COLUMN ${name} ${type}`);
    db.exec(`CREATE INDEX IF NOT EXISTS portal_bounties_owner ON portal_bounties(owner_id);
      CREATE INDEX IF NOT EXISTS portal_bounties_published ON portal_bounties(published, created_at);
      CREATE INDEX IF NOT EXISTS portal_sessions_expires ON portal_sessions(expires);
      UPDATE portal_bounties SET owner_id=json_extract(body,'$.ownerId'), published=json_extract(body,'$.published'), created_at=json_extract(body,'$.createdAt'), task_id=json_extract(body,'$.taskId') WHERE owner_id IS NULL;`);
  }
  /** Expired sessions and OAuth flows carry no value; prune them so tables stay bounded. */
  pruneExpired(now = Date.now()) {
    const sessions = this.db.prepare("DELETE FROM portal_sessions WHERE expires<?").run(now).changes;
    const flows = this.db.prepare("DELETE FROM portal_oauth WHERE expires<?").run(now).changes;
    return Number(sessions) + Number(flows);
  }
  seal(value: unknown): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
  }
  open<T>(value: string): T {
    const b = Buffer.from(value, "base64");
    const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(),
    ) as T;
  }
  user(id: number): User | undefined {
    const r = this.db
      .prepare("SELECT body FROM portal_users WHERE id=?")
      .get(id) as { body: string } | undefined;
    return r ? this.open<User>(r.body) : undefined;
  }
  saveUser(user: User) {
    this.db
      .prepare(
        "INSERT INTO portal_users VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(user.id, this.seal(user));
  }
  users(): User[] {
    return (
      this.db.prepare("SELECT body FROM portal_users").all() as {
        body: string;
      }[]
    ).map((r) => this.open<User>(r.body));
  }
  accessRequests(bountyId: string): AccessRequest[] {
    return this.db
      .prepare(
        "SELECT bounty_id AS bountyId,user_id AS userId,login,status,created_at AS createdAt FROM portal_access_requests WHERE bounty_id=? ORDER BY created_at",
      )
      .all(bountyId) as unknown as AccessRequest[];
  }
  requestAccess(b: Bounty, u: User) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO portal_access_requests(bounty_id,user_id,login,created_at) VALUES(?,?,?,?)",
      )
      .run(b.id, u.id, u.login, new Date().toISOString());
  }
  invited(bountyId: string, userId: number) {
    const user = this.user(userId);
    if (!user) throw new Error("Contributor must connect GitHub first");
    this.db
      .prepare(
        "INSERT INTO portal_access_requests(bounty_id,user_id,login,status,created_at) VALUES(?,?,?,'invited',?) ON CONFLICT(bounty_id,user_id) DO UPDATE SET status='invited'",
      )
      .run(bountyId, userId, user.login, new Date().toISOString());
  }
  accepted(bountyId: string, userId: number) {
    this.db
      .prepare(
        "UPDATE portal_access_requests SET status='accepted' WHERE bounty_id=? AND user_id=?",
      )
      .run(bountyId, userId);
  }
  /** A bounty read from the store saves only if unchanged since (compare-and-swap). */
  save(b: Bounty) {
    b.updatedAt = new Date().toISOString();
    const rev = (b as unknown as Record<symbol, number | undefined>)[REV];
    const projection = [b.ownerId, b.published ? 1 : 0, b.createdAt, b.taskId] as const;
    if (rev === undefined) {
      this.db
        .prepare(
          "INSERT INTO portal_bounties(id,code,body,rev,owner_id,published,created_at,task_id) VALUES(?,?,?,0,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,rev=rev+1,owner_id=excluded.owner_id,published=excluded.published,created_at=excluded.created_at,task_id=excluded.task_id",
        )
        .run(b.id, b.code, JSON.stringify(b), ...projection);
      withRev(b, (this.db.prepare("SELECT rev FROM portal_bounties WHERE id=?").get(b.id) as { rev: number }).rev);
    } else {
      const result = this.db
        .prepare("UPDATE portal_bounties SET body=?,rev=rev+1,owner_id=?,published=?,created_at=?,task_id=? WHERE id=? AND rev=?")
        .run(JSON.stringify(b), ...projection, b.id, rev);
      if (!result.changes) throw new StaleBountyError();
      withRev(b, rev + 1);
    }
    bumpDataVersion();
  }
  /** Read-modify-write without an await in between: safe against concurrent saves. */
  update(id: string, mutate: (b: Bounty) => void): Bounty {
    const b = this.bounty(id);
    mutate(b);
    this.save(b);
    return b;
  }
  find(id: string): Bounty | null {
    const r = this.db.prepare("SELECT body,rev FROM portal_bounties WHERE id=?").get(id) as { body: string; rev: number } | undefined;
    return r ? parse(r) : null;
  }
  bounty(id: string): Bounty {
    const r = this.db
      .prepare("SELECT body,rev FROM portal_bounties WHERE id=? OR code=?")
      .get(id, id) as { body: string; rev: number } | undefined;
    if (!r) throw new Error("Bounty not found");
    return parse(r);
  }
  all(): Bounty[] {
    return (
      this.db
        .prepare("SELECT body,rev FROM portal_bounties ORDER BY rowid DESC")
        .all() as { body: string; rev: number }[]
    ).map(parse);
  }
  /** Bounties owned by a user (indexed). */
  ownedBy(userId: number): Bounty[] {
    return (this.db.prepare("SELECT body,rev FROM portal_bounties WHERE owner_id=? ORDER BY rowid DESC").all(userId) as { body: string; rev: number }[]).map(parse);
  }
  byTaskIds(ids: string[]): Bounty[] {
    if (!ids.length) return [];
    const out: Bounty[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      out.push(...(this.db.prepare(`SELECT body,rev FROM portal_bounties WHERE task_id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as { body: string; rev: number }[]).map(parse));
    }
    return out;
  }
  enqueue(b: Bounty, kind: string) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO portal_jobs(id,bounty_id,kind) VALUES(?,?,?)",
      )
      .run(`${kind}:${b.id}`, b.id, kind);
  }
  jobs() {
    return this.db
      .prepare(
        "SELECT * FROM portal_jobs WHERE next_at<=? ORDER BY rowid LIMIT 10",
      )
      .all(Date.now()) as {
      id: string;
      bounty_id: string;
      kind: string;
      attempts: number;
    }[];
  }
  hasJob(bountyId: string) {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM portal_jobs WHERE bounty_id=? LIMIT 1")
        .get(bountyId),
    );
  }
  done(id: string) {
    this.db.prepare("DELETE FROM portal_jobs WHERE id=?").run(id);
  }
  retry(id: string, error: string, attempt: number) {
    this.db
      .prepare(
        "UPDATE portal_jobs SET attempts=attempts+1,next_at=?,error=? WHERE id=?",
      )
      .run(
        Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(attempt, 6)),
        error,
        id,
      );
  }
  meta(key: string, value?: string) {
    if (value !== undefined)
      this.db
        .prepare(
          "INSERT INTO portal_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(key, value);
    return (
      this.db.prepare("SELECT value FROM portal_meta WHERE key=?").get(key) as
        | { value: string }
        | undefined
    )?.value;
  }
}
export const digest = (v: string) =>
  createHash("sha256").update(v).digest("hex");
export const identity = (u: User): Identity => ({
  id: u.id,
  login: u.login,
  avatar: u.avatar,
  name: u.name,
  ...(u.local ? { local: true } : {}),
});
