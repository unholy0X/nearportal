import type { DatabaseSync } from "node:sqlite";
import { hash } from "../tasks/domain.ts";
import { bumpDataVersion } from "../ops/version.ts";
import { transition, type Command, type Market } from "./market.ts";

/** Durable facts for a future reputation system. No score is computed or displayed. */
export type ActivityKind = "assignment-confirmed" | "submission-received" | "assignment-expired" | "assignment-withdrawn" | "payment-confirmed";
export interface ActivityEvent {
  bountyId: string;
  generation: number;
  userId: number;
  kind: ActivityKind;
  at: number;
  /** "sandbox" (testnet + Monerium sandbox), "simulation" or a future real environment. */
  environment: string;
  /** Who caused it. Provider or binding delays are never attributed to the developer. */
  cause?: "developer" | "deadline" | "settlement";
}

/** Encrypted sealed bids, optimistic revisions, audit and transactional chain outbox.
 * Network calls must never run inside this database transaction.
 */
export class MarketStore {
  constructor(readonly db: DatabaseSync, readonly crypto: { seal(v: unknown): string; open<T>(v: string): T }) {
    db.exec(`CREATE TABLE IF NOT EXISTS portal_markets(
      bounty_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS portal_market_events(
        bounty_id TEXT NOT NULL, revision INTEGER NOT NULL, command TEXT NOT NULL,
        at INTEGER NOT NULL, state_hash TEXT NOT NULL, PRIMARY KEY(bounty_id,revision));
      CREATE TABLE IF NOT EXISTS portal_market_outbox(
        id TEXT PRIMARY KEY, bounty_id TEXT NOT NULL, revision INTEGER NOT NULL,
        kind TEXT NOT NULL, body TEXT NOT NULL, completed_at INTEGER);
      CREATE TABLE IF NOT EXISTS portal_activity_events(
        id TEXT PRIMARY KEY, bounty_id TEXT NOT NULL, generation INTEGER NOT NULL, user_id INTEGER NOT NULL,
        kind TEXT NOT NULL, at INTEGER NOT NULL, environment TEXT NOT NULL, cause TEXT);
      CREATE INDEX IF NOT EXISTS portal_activity_user ON portal_activity_events(user_id, environment);
      CREATE TABLE IF NOT EXISTS portal_schema_versions(name TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at TEXT NOT NULL);
      INSERT OR IGNORE INTO portal_schema_versions VALUES('fixed-deadline-market', 1, datetime('now'));`);
  }
  create(bountyId: string, state: Market) {
    if (state.revision !== 0 || state.phase !== "unfunded") throw new Error("Create an unfunded market");
    this.db.prepare("INSERT INTO portal_markets VALUES(?,?,?)").run(bountyId, 0, this.crypto.seal(state));
    bumpDataVersion();
  }
  /** Idempotent creation for a retried preparation step. */
  ensure(bountyId: string, state: Market) {
    if (!this.find(bountyId)) this.create(bountyId, state);
    return this.get(bountyId);
  }
  find(bountyId: string): Market | null {
    const row = this.db.prepare("SELECT body FROM portal_markets WHERE bounty_id=?").get(bountyId) as { body: string } | undefined;
    return row ? this.crypto.open<Market>(row.body) : null;
  }
  get(bountyId: string): Market {
    const m = this.find(bountyId);
    if (!m) throw new Error("No versioned bounty agreement");
    return m;
  }
  /**
   * Apply one command with compare-and-swap. `within` runs in the same transaction (e.g. the
   * matching task policy change), so the market and the task never diverge.
   */
  apply(bountyId: string, expectedRevision: number, command: Command, now: number, within?: (next: Market) => void): Market {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(bountyId);
      if (current.revision !== expectedRevision) throw new Error("Bounty changed; refresh before continuing");
      const next = transition(current, command, now);
      const changed = this.db.prepare("UPDATE portal_markets SET revision=?,body=? WHERE bounty_id=? AND revision=?")
        .run(next.revision, this.crypto.seal(next), bountyId, expectedRevision);
      if (changed.changes !== 1) throw new Error("Concurrent bounty update");
      // Commands carrying personal data (eligibility) are audited by type and state hash only.
      this.db.prepare("INSERT INTO portal_market_events VALUES(?,?,?,?,?)")
        .run(bountyId, next.revision, command.type, now, hash(next));
      // Outbox IDs are reconciliation keys, never permission to blindly repeat a transfer.
      if (["claim", "accept-offer", "submit", "request-withdraw", "withdraw", "expire", "authorize-payment", "pause"].includes(command.type)) {
        this.db.prepare("INSERT INTO portal_market_outbox(id,bounty_id,revision,kind,body) VALUES(?,?,?,?,?)")
          .run(`${bountyId}:${next.revision}`, bountyId, next.revision, command.type, this.crypto.seal({ command: command.type, generation: next.assignment?.generation ?? next.generation }));
      }
      within?.(next);
      this.db.exec("COMMIT");
      bumpDataVersion();
      return next;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Worker commands: re-read the latest revision inside the transaction (still CAS-protected). */
  applyLatest(bountyId: string, command: Command, now: number, within?: (next: Market) => void): Market {
    return this.apply(bountyId, this.get(bountyId).revision, command, now, within);
  }
  /** The state-driven worker acknowledges outbox entries once the chain reflects them. */
  acknowledge(bountyId: string, kinds: string[], upToRevision: number, now = Date.now()) {
    if (!kinds.length) return;
    this.db.prepare(`UPDATE portal_market_outbox SET completed_at=? WHERE bounty_id=? AND completed_at IS NULL AND revision<=? AND kind IN (${kinds.map(() => "?").join(",")})`).run(now, bountyId, upToRevision, ...kinds);
  }
  pending(bountyId: string) {
    return this.db.prepare("SELECT id,revision,kind FROM portal_market_outbox WHERE bounty_id=? AND completed_at IS NULL ORDER BY revision").all(bountyId) as { id: string; revision: number; kind: string }[];
  }
  /** Deduplicated per bounty, generation and kind. */
  record(event: ActivityEvent): boolean {
    const id = `${event.bountyId}:${event.generation}:${event.kind}`;
    return Boolean(this.db.prepare("INSERT OR IGNORE INTO portal_activity_events VALUES(?,?,?,?,?,?,?,?)").run(id, event.bountyId, event.generation, event.userId, event.kind, event.at, event.environment, event.cause ?? null).changes);
  }
  activity(filter: { userId?: number; bountyId?: string } = {}) {
    const rows = this.db.prepare("SELECT bounty_id AS bountyId, generation, user_id AS userId, kind, at, environment, cause FROM portal_activity_events WHERE (? IS NULL OR user_id=?) AND (? IS NULL OR bounty_id=?) ORDER BY at, id").all(filter.userId ?? null, filter.userId ?? null, filter.bountyId ?? null, filter.bountyId ?? null);
    return rows as unknown as ActivityEvent[];
  }
}
