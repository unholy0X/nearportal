import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PortalStore } from "../server/portal/store.ts";
import { gasSponsor } from "../server/crypto/gas.ts";
import { repairGasEncryption } from "../scripts/repair-gas-encryption.ts";

test("operator and runtime use the same configured encryption key and preserve the gas sponsor", () => {
  const previous = process.env.PORTAL_ENCRYPTION_KEY;
  const dir = mkdtempSync(join(tmpdir(), "nearportal-encryption-"));
  const db = new DatabaseSync(":memory:"), key = randomBytes(32);
  try {
    process.env.PORTAL_ENCRYPTION_KEY = key.toString("base64");
    const operator = new PortalStore(db, dir);
    const before = gasSponsor(operator).address;
    const runtime = new PortalStore(db, dir, key);
    assert.equal(gasSponsor(runtime).address, before);
    assert.equal(gasSponsor(new PortalStore(db, dir)).address, before);
    assert.equal(existsSync(join(dir, "portal-encryption.key")), false);
    process.env.PORTAL_ENCRYPTION_KEY = "invalid";
    assert.throws(() => new PortalStore(db, dir), /32 bytes/);
    assert.equal(existsSync(join(dir, "portal-encryption.key")), false);
    assert.equal(gasSponsor(new PortalStore(db, dir, key)).address, before);
    delete process.env.PORTAL_ENCRYPTION_KEY;
    const fallback = new PortalStore(db, dir);
    const sealed = fallback.seal({ test: true });
    assert.deepEqual(new PortalStore(db, dir).open(sealed), { test: true });
    assert.throws(() => fallback.open(operator.meta("crypto-sponsor-key")!));
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PORTAL_ENCRYPTION_KEY;
    else process.env.PORTAL_ENCRYPTION_KEY = previous;
  }
});

test("legacy gas recovery rewraps only the existing key, checks its address, and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "nearportal-recovery-")), db = new DatabaseSync(":memory:");
  const legacyKey = randomBytes(32), runtimeKey = randomBytes(32);
  try {
    writeFileSync(join(dir, "portal-encryption.key"), legacyKey, { mode: 0o600 });
    const legacy = new PortalStore(db, dir, legacyKey), address = gasSponsor(legacy).address;
    const before = legacy.meta("crypto-sponsor-key");
    legacy.meta("unrelated", "preserve");
    assert.throws(() => repairGasEncryption(db, dir, runtimeKey, "0x" + "1".repeat(40)), /mismatch/);
    assert.equal(legacy.meta("crypto-sponsor-key"), before);
    legacy.meta("crypto-gas-active", "pending");
    assert.throws(() => repairGasEncryption(db, dir, runtimeKey, address), /journals already exist/);
    db.prepare("DELETE FROM portal_meta WHERE key='crypto-gas-active'").run();
    assert.deepEqual(repairGasEncryption(db, dir, runtimeKey, address), { address, changed: true });
    assert.deepEqual(repairGasEncryption(db, dir, runtimeKey, address), { address, changed: false });
    assert.equal(gasSponsor(new PortalStore(db, dir, runtimeKey)).address, address);
    assert.equal(legacy.meta("unrelated"), "preserve");
    assert.notEqual(legacy.meta("crypto-sponsor-key"), before);
    assert.equal((legacy.open<{key:string}>(before!)).key,
      (new PortalStore(db, dir, runtimeKey).open<{key:string}>(legacy.meta("crypto-sponsor-key")!)).key);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
