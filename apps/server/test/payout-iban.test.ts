import test from "node:test";
import assert from "node:assert/strict";
import { parsePayout } from "../server/tasks/payout.ts";

const holder = { firstName: "Test", lastName: "Testson", country: "EE" };
// Issued by Monerium sandbox (BIC FAKEFK01): valid mod-97, fails the Estonian national check digit.
const moneriumSandbox = "EE38 8961 1939 2300 0322";

test("Monerium sandbox test IBANs are accepted in sandbox mode", () => {
  assert.equal(parsePayout({ ...holder, iban: moneriumSandbox }, [], true).iban, "EE388961193923000322");
});

test("live mode keeps strict national IBAN validation", () => {
  assert.throws(() => parsePayout({ ...holder, iban: moneriumSandbox }), /Enter a valid SEPA IBAN/);
  assert.throws(() => parsePayout({ ...holder, iban: moneriumSandbox }, [], false), /Enter a valid SEPA IBAN/);
});

test("sandbox mode still rejects bad checksums, formats and non-SEPA countries", () => {
  for (const iban of ["EE39 8961 1939 2300 0322", "EE38 8961 1939 2300 032", "US64 SVBK US6S 3300 9673 8637", "not an iban"])
    assert.throws(() => parsePayout({ ...holder, iban }, [], true), /Enter a valid SEPA IBAN/, iban);
});

test("valid real-format IBANs are unaffected", () => {
  assert.equal(parsePayout({ ...holder, iban: "FR1420041010050500013M02606" }).iban, "FR1420041010050500013M02606");
});
