import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { Task } from "./domain.ts";
import { bumpDataVersion } from "../ops/version.ts";

/** Hidden revision read with a task; a save from an older copy is refused (compare-and-swap). */
const REV = Symbol("revision");
export class StaleWriteError extends Error {
  constructor() {
    super("This task changed while the update was in progress. Refresh and try again.");
    this.name = "StaleWriteError";
  }
}
const withRev = (t: Task, rev: number) => {
  Object.defineProperty(t, REV, { value: rev, enumerable: false, writable: true, configurable: true });
  return t;
};

/** A single-process durable queue. A transaction commits each task and its event together. */
export class TaskStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue(task_id TEXT PRIMARY KEY REFERENCES tasks(id), attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS releases(task_id TEXT PRIMARY KEY REFERENCES tasks(id), evidence_hash TEXT NOT NULL, created_at TEXT NOT NULL);`);
    const columns = (table: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!columns("tasks").includes("rev")) this.db.exec("ALTER TABLE tasks ADD COLUMN rev INTEGER NOT NULL DEFAULT 0");
    if (!columns("deliveries").includes("event")) this.db.exec("ALTER TABLE deliveries ADD COLUMN event TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS queue_next ON queue(next_at)");
  }
  transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = run(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  get(id: string): Task {
    const row = this.db.prepare("SELECT body,rev FROM tasks WHERE id=?").get(id) as { body: string; rev: number } | undefined;
    if (!row) throw new Error("Task not found");
    return withRev(JSON.parse(row.body) as Task, row.rev);
  }
  all(): Task[] { return (this.db.prepare("SELECT body,rev FROM tasks").all() as { body: string; rev: number }[]).map((r) => withRev(JSON.parse(r.body) as Task, r.rev)); }
  /** Tasks by id in one query (missing ids are skipped). */
  many(ids: string[]): Map<string, Task> {
    const out = new Map<string, Task>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.db.prepare(`SELECT id,body,rev FROM tasks WHERE id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as { id: string; body: string; rev: number }[];
      for (const r of rows) out.set(r.id, withRev(JSON.parse(r.body) as Task, r.rev));
    }
    return out;
  }
  /**
   * A task read from the store saves only if nobody saved it since (otherwise StaleWriteError);
   * a newly built task is inserted.
   */
  save(t: Task): void {
    const rev = (t as unknown as Record<symbol, number | undefined>)[REV];
    if (rev === undefined) {
      this.db.prepare("INSERT INTO tasks(id,body,rev) VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET body=excluded.body,rev=rev+1").run(t.id, JSON.stringify(t));
      const row = this.db.prepare("SELECT rev FROM tasks WHERE id=?").get(t.id) as { rev: number };
      withRev(t, row.rev);
    } else {
      const result = this.db.prepare("UPDATE tasks SET body=?,rev=rev+1 WHERE id=? AND rev=?").run(JSON.stringify(t), t.id, rev);
      if (!result.changes) throw new StaleWriteError();
      withRev(t, rev + 1);
    }
    bumpDataVersion();
  }
  /** Wake a task now (user action, webhook). */
  enqueue(id: string): void { const now = Date.now(); this.db.prepare("INSERT INTO queue(task_id,next_at) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET next_at=MIN(next_at,excluded.next_at)").run(id, now); }
  /** Make sure a task is queued without disturbing an existing schedule or backoff. */
  ensureQueued(id: string): boolean { return Boolean(this.db.prepare("INSERT OR IGNORE INTO queue(task_id,next_at) VALUES(?,?)").run(id, Date.now()).changes); }
  delivery(id: string, ids: string[], event = ""): boolean {
    return this.transaction(() => {
      const result = this.db.prepare("INSERT OR IGNORE INTO deliveries(id,received_at,event) VALUES(?,?,?)").run(id, new Date().toISOString(), event);
      if (!result.changes) return false;
      ids.forEach((taskId) => this.enqueue(taskId));
      return true;
    });
  }
  /** Delivery IDs are kept long enough to absorb GitHub redeliveries, then pruned. */
  pruneDeliveries(maxAgeMs = 7 * 86_400_000): number {
    return Number(this.db.prepare("DELETE FROM deliveries WHERE received_at < ?").run(new Date(Date.now() - maxAgeMs).toISOString()).changes);
  }
  /** Oldest-due first, so a task that keeps failing cannot hold the head of the queue. */
  due(limit = 10, exclude: Set<string> = new Set()): string[] {
    const rows = this.db.prepare("SELECT task_id FROM queue WHERE next_at <= ? ORDER BY next_at, rowid LIMIT ?").all(Date.now(), limit + exclude.size) as { task_id: string }[];
    return rows.map((r) => r.task_id).filter((id) => !exclude.has(id)).slice(0, limit);
  }
  /** Failure: attempts grow, the caller supplies the backoff delay. */
  retry(id: string, error: string | null, delay = 10_000): void { this.db.prepare("UPDATE queue SET attempts=attempts+1,next_at=?,error=? WHERE task_id=?").run(Date.now() + delay, error, id); }
  /** Healthy pass: schedule the next check and clear the failure streak. */
  wait(id: string, delay: number): void { this.db.prepare("UPDATE queue SET attempts=0,next_at=?,error=NULL WHERE task_id=?").run(Date.now() + delay, id); }
  /** Provider-wide deferral: does not count as a failure of this task. */
  defer(id: string, delay: number, reason: string): void { this.db.prepare("UPDATE queue SET next_at=?,error=? WHERE task_id=?").run(Date.now() + delay, reason, id); }
  attempts(id: string): number { return (this.db.prepare("SELECT attempts FROM queue WHERE task_id=?").get(id) as { attempts: number } | undefined)?.attempts ?? 0; }
  queueStats(now = Date.now()) {
    const row = this.db.prepare("SELECT COUNT(*) AS size, SUM(CASE WHEN next_at<=? THEN 1 ELSE 0 END) AS due, MIN(CASE WHEN next_at<=? THEN next_at END) AS oldest, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failing FROM queue").get(now, now) as { size: number; due: number | null; oldest: number | null; failing: number | null };
    return { size: row.size, due: row.due ?? 0, oldestDueAgeMs: row.oldest !== null && row.oldest > 0 ? now - row.oldest : 0, failing: row.failing ?? 0 };
  }
  done(id: string): void { this.db.prepare("DELETE FROM queue WHERE task_id=?").run(id); }
  hasRelease(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM releases WHERE task_id=?").get(id)); }
  authorize(t: Task, evidenceHash: string): void {
    this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO releases VALUES(?,?,?)").run(t.id, evidenceHash, new Date().toISOString());
      this.save(t);
    });
  }
  /** Same as authorize, inside a caller's transaction (market + task commit together). */
  authorizeWithin(t: Task, evidenceHash: string): void {
    this.db.prepare("INSERT OR IGNORE INTO releases VALUES(?,?,?)").run(t.id, evidenceHash, new Date().toISOString());
    this.save(t);
  }
  close(): void { this.db.close(); }
}
