// Restore drill: copies a backup into a fresh directory, verifies digests, SQLite integrity,
// the encryption-key pairing (credentials and encrypted payment journals must decrypt), and the relayer journals.
// It never touches the live data directory. Usage:
//   PORTAL_ENCRYPTION_KEY=<base64> node --import tsx scripts/restore-check.ts <backup-dir> <empty-restore-dir>
import { DatabaseSync } from "node:sqlite";
import { createHash, createDecipheriv } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { keyFingerprint } from "./backup.ts";

export function restoreCheck(options: { backup: string; target: string; key: Buffer }) {
  const backup = resolve(options.backup), target = resolve(options.target);
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || readdirSync(target).length)) throw new Error("Restore target must be empty (never restore over live data)");
  const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")) as { format: number; files: { name: string; sha256: string }[]; keyFingerprint: string | null; counts: Record<string, number | null> };
  if (![1, 2].includes(manifest.format) || !Array.isArray(manifest.files) || !manifest.counts || options.key.length !== 32)
    throw new Error("Invalid backup manifest or encryption key");
  const names = new Set<string>();
  for (const f of manifest.files) {
    if (!/^(github-tasks\.sqlite|github-relayer(?:-\d+)?\.json)$/.test(f.name) || names.has(f.name) ||
        !/^[a-f0-9]{64}$/.test(f.sha256) || !lstatSync(join(backup, f.name)).isFile() || lstatSync(join(backup, f.name)).isSymbolicLink())
      throw new Error("Invalid backup file entry");
    names.add(f.name);
  }
  if (!names.has("github-tasks.sqlite")) throw new Error("Backup database is missing");
  if (manifest.keyFingerprint && manifest.keyFingerprint !== keyFingerprint(options.key)) throw new Error("This encryption key does not belong to the backup");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const f of manifest.files) {
    const bytes = readFileSync(join(backup, f.name));
    if (createHash("sha256").update(bytes).digest("hex") !== f.sha256) throw new Error(`Digest mismatch: ${f.name}`);
    copyFileSync(join(backup, f.name), join(target, f.name));
    chmodSync(join(target, f.name), 0o600);
  }
  const db = new DatabaseSync(join(target, "github-tasks.sqlite"), { readOnly: true });
  try {
    const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    if (integrity !== "ok") throw new Error(`SQLite integrity check failed: ${integrity}`);
    const counts: Record<string, number> = {};
    const tables = new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(t => t.name));
    if (manifest.format === 2 && (tables.size !== Object.keys(manifest.counts).length || [...tables].some(t => !(t in manifest.counts))))
      throw new Error("Backup table inventory mismatch");
    for (const t of Object.keys(manifest.counts)) {
      if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error("Invalid backup table name");
      if (manifest.counts[t] === null) continue;
      counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      if (counts[t] !== manifest.counts[t]) throw new Error(`Row count mismatch for ${t}`);
    }
    let users = 0;
    const encryptedRecords: Record<string, number> = {};
    const decrypt = (value: string) => {
      const b = Buffer.from(value, "base64");
      const d = createDecipheriv("aes-256-gcm", options.key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
    };
    try {
      for (const table of ["portal_users", "portal_markets", "portal_market_outbox", "portal_treasury_funding"]) {
        if (!tables.has(table)) continue;
        const rows = db.prepare(`SELECT body FROM ${table}`).all() as { body: string }[];
        for (const row of rows) decrypt(row.body);
        encryptedRecords[table] = rows.length;
      }
      users = encryptedRecords.portal_users ?? 0;
      if (tables.has("portal_oauth")) {
        const rows = db.prepare("SELECT verifier FROM portal_oauth").all() as { verifier: string }[];
        for (const row of rows) decrypt(row.verifier);
        encryptedRecords.portal_oauth = rows.length;
      }
      if (tables.has("portal_meta")) {
        const rows = db.prepare("SELECT key,value FROM portal_meta").all() as { key: string; value: string }[];
        const encrypted = rows.filter(r => ["crypto-sponsor-key", "demo-treasury-key", "crypto-sponsor-seed"].includes(r.key) || /^(crypto-payout:|crypto-gas:)/.test(r.key));
        for (const row of encrypted) decrypt(row.value);
        encryptedRecords.portal_meta = encrypted.length;
      }
    } catch (error) {
      throw new Error(`Encrypted records do not open with this key: ${(error as Error).message}`);
    }
    // Every task with a payment in flight must still be represented after restore.
    const inflight = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE json_extract(body,'$.payment.state') NOT IN ('NotRequested','Processed')").get() as { n: number }).n;
    const refundsInFlight = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE json_extract(body,'$.refund.state') NOT IN ('NotRequested','Processed')").get() as { n: number }).n;
    const journals = manifest.files.filter((f) => f.name.endsWith(".json")).map((f) => {
      const state = JSON.parse(readFileSync(join(target, f.name), "utf8"));
      if (!state.bounties || !Array.isArray(state.reportedOrders) || !state.submitted) throw new Error(`Malformed relayer journal: ${f.name}`);
      return { name: f.name, bounties: Object.keys(state.bounties).length, pendingSubmissions: Object.keys(state.pendingSubmissions ?? {}).length };
    });
    return { ok: true, target, counts, usersDecrypted: users, encryptedRecords, paymentsInFlight: inflight, refundsInFlight, journals };
  } finally { db.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [backupDir, target] = process.argv.slice(2);
  if (!backupDir || !target || !process.env.PORTAL_ENCRYPTION_KEY) throw new Error("Usage: PORTAL_ENCRYPTION_KEY=… scripts/restore-check.ts <backup-dir> <empty-restore-dir>");
  console.log(JSON.stringify(restoreCheck({ backup: backupDir, target, key: Buffer.from(process.env.PORTAL_ENCRYPTION_KEY, "base64") }), null, 2));
}
