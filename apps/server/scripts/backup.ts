// Consistent online backup: SQLite snapshot (VACUUM INTO, a transactionally consistent copy taken
// while the server runs) plus the relayer JSON journals, with a manifest of SHA-256 digests.
// The encryption key is NOT copied: back it up separately; the manifest records its fingerprint so
// a restore can prove the pairing. Usage:
//   node --import tsx scripts/backup.ts <output-dir>       (DATA_DIR / TASK_DB from the environment)
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export function keyFingerprint(key: Buffer) {
  return createHash("sha256").update("nearportal-key-fingerprint:").update(key).digest("hex").slice(0, 16);
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function encryptionKey(dataDir: string): Buffer | null {
  if (process.env.PORTAL_ENCRYPTION_KEY) return Buffer.from(process.env.PORTAL_ENCRYPTION_KEY, "base64");
  const file = join(dataDir, "portal-encryption.key");
  return existsSync(file) ? readFileSync(file) : null;
}

export function backup(options: { dataDir: string; dbPath: string; out: string }) {
  const out = resolve(options.out);
  if (existsSync(out) && (lstatSync(out).isSymbolicLink() || readdirSync(out).length)) throw new Error(`Backup directory must be empty and not a symlink: ${out}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const journals = () =>
    existsSync(options.dataDir)
      ? readdirSync(options.dataDir).filter((f) => /^github-relayer(?:-\d+)?\.json$/.test(f)).sort().map((f) => ({ name: f, bytes: readFileSync(join(options.dataDir, f)) }))
      : [];
  // Journals are rewritten atomically by the worker. Take them before and after the database
  // snapshot and retry until they did not change in between, so both describe the same moment.
  let before = journals();
  const dbFile = join(out, "github-tasks.sqlite");
  for (let attempt = 0; ; attempt++) {
    const db = new DatabaseSync(options.dbPath, { readOnly: true });
    try {
      db.exec(`VACUUM INTO '${dbFile.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    const after = journals();
    if (JSON.stringify(after.map((j) => [j.name, sha(j.bytes)])) === JSON.stringify(before.map((j) => [j.name, sha(j.bytes)]))) break;
    if (attempt >= 4) throw new Error("Relayer journal kept changing during backup; retry when the worker is idle");
    before = after;
    // VACUUM INTO refuses an existing file: remove the snapshot before retrying.
    unlinkSync(dbFile);
  }
  for (const j of before) writeFileSync(join(out, j.name), j.bytes, { mode: 0o600 });
  chmodSync(dbFile, 0o600);
  const snapshot = new DatabaseSync(dbFile, { readOnly: true });
  let counts: Record<string, number>;
  try {
    const tables = snapshot.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    counts = Object.fromEntries(tables.map(({ name }) => {
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("Unexpected table name in backup");
      return [name, (snapshot.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n];
    }));
  } finally { snapshot.close(); }
  const key = encryptionKey(options.dataDir);
  const files = readdirSync(out).sort().map((f) => ({ name: f, sha256: sha(readFileSync(join(out, f))) }));
  const manifest = { format: 2, createdAt: new Date().toISOString(), source: basename(options.dbPath), counts, keyFingerprint: key ? keyFingerprint(key) : null, files };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2];
  if (!out) throw new Error("Usage: scripts/backup.ts <output-dir>");
  const dataDir = process.env.DATA_DIR ?? "data";
  const manifest = backup({ dataDir, dbPath: process.env.TASK_DB ?? join(dataDir, "github-tasks.sqlite"), out });
  console.log(JSON.stringify({ backup: resolve(out), counts: manifest.counts, keyFingerprint: manifest.keyFingerprint, files: manifest.files.length }));
}
