import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../server/tasks/store.ts";
import { PortalStore } from "../server/portal/store.ts";
import { commitGasIntent, gasSponsor } from "../server/crypto/gas.ts";

test("racing gas intents on separate connections cannot overwrite a nonce journal or exceed the quota", () => {
  const dir = mkdtempSync(join(tmpdir(), "nearportal-gas-race-")), key = randomBytes(32);
  const first = new TaskStore(join(dir, "test.sqlite")), second = new TaskStore(join(dir, "test.sqlite"));
  try {
    const a = new PortalStore(first.db, dir, key), b = new PortalStore(second.db, dir, key);
    assert.equal(gasSponsor(a).address, gasSponsor(b).address);
    const day = "2026-11-05", intent = { raw: "0x1234", hash: "0xabcd" } as const;
    a.meta("crypto-gas-count:" + day, "9");
    // Both contenders observed an idle sponsor before asynchronous nonce preparation.
    assert.equal(a.meta("crypto-gas-active"), undefined);
    assert.equal(b.meta("crypto-gas-active"), undefined);
    commitGasIntent(a, "first", intent, day);
    assert.throws(() => commitGasIntent(b, "second", { raw: "0x5678", hash: "0xdcba" }, day), /changed while preparing/);
    assert.throws(() => commitGasIntent(b, "first", { raw: "0x5678", hash: "0xdcba" }, day), /changed while preparing/);
    assert.deepEqual(b.open(b.meta("crypto-gas:first")!), intent);
    assert.equal(b.meta("crypto-gas:second"), undefined);
    assert.equal(b.meta("crypto-gas-count:" + day), "10");
    a.meta("crypto-gas-active", "");
    assert.throws(() => commitGasIntent(b, "second", intent, day), /limit reached/);
    assert.equal(b.meta("crypto-gas:second"), undefined);
    assert.deepEqual(b.open(b.meta("crypto-gas:first")!), intent);
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});
