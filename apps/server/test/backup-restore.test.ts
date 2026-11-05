import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../server/tasks/store.ts";
import { PortalStore } from "../server/portal/store.ts";
import { backup } from "../scripts/backup.ts";
import { restoreCheck } from "../scripts/restore-check.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "np-backup-")), key = randomBytes(32);
  const tasks = new TaskStore(join(dir, "source.sqlite"));
  const store = new PortalStore(tasks.db, dir, key);
  const prior = process.env.PORTAL_ENCRYPTION_KEY;
  process.env.PORTAL_ENCRYPTION_KEY = key.toString("base64");
  return {
    dir, key, tasks, store,
    snapshot() { const out = join(dir, "backup"); return { out, manifest: backup({ dataDir: dir, dbPath: join(dir, "source.sqlite"), out }) }; },
    cleanup() { tasks.close(); rmSync(dir, { recursive: true, force: true }); if (prior === undefined) delete process.env.PORTAL_ENCRYPTION_KEY; else process.env.PORTAL_ENCRYPTION_KEY = prior; },
  };
}

test("restore verifies every table plus encrypted gas, payout, market and OAuth records", () => {
  const f = fixture();
  try {
    for (const table of ["portal_markets", "portal_market_outbox", "portal_treasury_funding"]) {
      f.tasks.db.exec(`CREATE TABLE ${table}(body TEXT NOT NULL)`);
      f.tasks.db.prepare(`INSERT INTO ${table}(body) VALUES(?)`).run(f.store.seal({ secret: "never-print-this" }));
    }
    f.tasks.db.exec("CREATE TABLE agent_recovery_fixture(key TEXT PRIMARY KEY); INSERT INTO agent_recovery_fixture VALUES('durable-idempotency-key')");
    for (const k of ["crypto-sponsor-key", "crypto-payout:task", "crypto-gas:task"])
      f.store.meta(k, f.store.seal({ secret: "never-print-this" }));
    f.tasks.db.prepare("INSERT INTO portal_oauth(hash,verifier,expires) VALUES(?,?,?)").run("state", f.store.seal({ verifier: "secret" }), Date.now() + 60_000);
    const { out, manifest } = f.snapshot();
    assert.equal(manifest.counts.agent_recovery_fixture, 1);
    const result = restoreCheck({ backup: out, target: join(f.dir, "restored"), key: f.key });
    assert.equal(result.encryptedRecords.portal_meta, 3);
    assert.equal(result.encryptedRecords.portal_oauth, 1);
    assert.equal(result.encryptedRecords.portal_markets, 1);
    assert.equal(result.counts.agent_recovery_fixture, 1);
    assert.equal(JSON.stringify(result).includes("never-print-this"), false);
    manifest.format = 1;
    writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
    assert.equal(restoreCheck({ backup: out, target: join(f.dir, "legacy"), key: f.key }).ok, true);
  } finally { f.cleanup(); }
});

test("restore refuses a correctly fingerprinted snapshot with an undecryptable funded gas key", () => {
  const f = fixture();
  try {
    const other = new PortalStore(f.tasks.db, f.dir, randomBytes(32));
    f.store.meta("crypto-sponsor-key", other.seal({ key: "test-only" }));
    const { out } = f.snapshot();
    assert.throws(() => restoreCheck({ backup: out, target: join(f.dir, "restore"), key: f.key }), /Encrypted records do not open/);
  } finally { f.cleanup(); }
});

test("restore rejects manifest path traversal and symlink sources before writing files", () => {
  const f = fixture();
  try {
    const { out, manifest } = f.snapshot();
    const original = readFileSync(join(out, "manifest.json"));
    manifest.files.push({ name: "../escaped.json", sha256: "0".repeat(64) });
    writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
    const target = join(f.dir, "restored");
    assert.throws(() => restoreCheck({ backup: out, target, key: f.key }), /Invalid backup file entry/);
    assert.equal(existsSync(target), false);
    writeFileSync(join(out, "manifest.json"), original);
    unlinkSync(join(out, "github-tasks.sqlite"));
    symlinkSync(join(f.dir, "source.sqlite"), join(out, "github-tasks.sqlite"));
    assert.throws(() => restoreCheck({ backup: out, target, key: f.key }), /Invalid backup file entry/);
    assert.equal(existsSync(target), false);
  } finally { f.cleanup(); }
});
