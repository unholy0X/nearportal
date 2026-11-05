// One-row recovery after an operator encrypted the gas key with the file fallback.
// No generation, signing or broadcast. Back up the database and retain the legacy file first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { PortalStore } from "../server/portal/store.ts";

export function repairGasEncryption(db: DatabaseSync, directory: string, runtimeKey: Buffer, expectedAddress: string) {
  assert.equal(runtimeKey.length, 32);
  const runtime = new PortalStore(db, directory, runtimeKey);
  const sealed = runtime.meta("crypto-sponsor-key");
  assert.ok(sealed, "Existing funded gas sponsor required; never generate a replacement");
  const check = (value: { key: Hex }) => {
    const address = privateKeyToAccount(value.key).address;
    assert.equal(address.toLowerCase(), expectedAddress.toLowerCase(), "Funded sponsor address mismatch");
    return address;
  };
  let current: { key: Hex } | undefined;
  try { current = runtime.open(sealed); } catch { /* Explicit legacy recovery below. */ }
  if (current) return { address: check(current), changed: false };
  assert.equal(db.prepare("SELECT count(*) AS n FROM portal_meta WHERE key LIKE 'crypto-gas%' OR key='crypto-sponsor-seed'").get()!.n, 0,
    "Gas journals already exist: reconcile their encryption before repairing");
  const legacy = new PortalStore(db, directory, readFileSync(join(directory, "portal-encryption.key")));
  const original = legacy.open<{ key: Hex }>(sealed), address = check(original);
  const replacement = runtime.seal(original);
  assert.equal(check(runtime.open(replacement)), address);
  db.exec("BEGIN IMMEDIATE");
  try {
    assert.equal(db.prepare("UPDATE portal_meta SET value=? WHERE key='crypto-sponsor-key' AND value=?").run(replacement, sealed).changes, 1,
      "Gas key changed concurrently; abort recovery");
    assert.equal(check(runtime.open(runtime.meta("crypto-sponsor-key")!)), address);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { address, changed: true };
}
