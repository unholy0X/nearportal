import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptsDeposits, amountFromMessage, counterpart, eurToCents, payeeFor, shortIban } from "../src/logic.ts";

test("shortIban matches Monerium's format", () => {
  // Monerium sandbox example IBAN; use one issued to your own Monerium sandbox account.
  assert.equal(shortIban("FR76 3000 6000 0112 3456 7890 189"), "FR76...0189");
  assert.equal(shortIban("ee38220022102014 5685"), "EE38...5685");
});

test("eurToCents parses Monerium amounts", () => {
  assert.equal(eurToCents("720"), 72_000);
  assert.equal(eurToCents("10.5"), 1_050);
  assert.equal(eurToCents("0.05"), 5);
  assert.throws(() => eurToCents("1,5"));
  assert.throws(() => eurToCents("-1"));
});

test("amountFromMessage reads the signed amount", () => {
  assert.equal(amountFromMessage("Send EUR 216 to FR76...0189 at 2026-10-20T15:20:52Z"), "216");
  assert.equal(amountFromMessage("Send EUR 720.50 to FR76...0189 at 2026-10-20T15:20:52Z"), "720.50");
  assert.throws(() => amountFromMessage("Send EUR 216 to somebody"));
});

test("deposits are reported for every bounty state except an unverified or rejected address", () => {
  for (const state of ["AwaitingDeposit", "Funded", "Disputed", "Closed"] as const) assert.equal(acceptsDeposits(state), true, state);
  assert.equal(acceptsDeposits("VerifyingAddress"), false);
  assert.equal(acceptsDeposits("Cancelled"), false);
});

test("payeeFor follows the payout kind and the signed short IBAN", () => {
  // Monerium sandbox example IBAN; use one issued to your own Monerium sandbox account.
  const developer = { iban: "FR7630006000011234567890189", firstName: "Ada", lastName: "Example", country: "FR" };
  const client = { iban: "FR1420041010050500013M02606", firstName: "Grace", lastName: "Example", country: "FR" };
  assert.equal(payeeFor({ kind: "Developer", short_iban: "FR76...0189" }, { developer, client }), developer);
  assert.equal(payeeFor({ kind: "Refund", short_iban: "FR14...2606" }, { developer, client }), client);
  assert.equal(payeeFor({ kind: "SurplusRefund", short_iban: "FR14...2606" }, { client }), client);
  assert.throws(() => payeeFor({ kind: "Developer", short_iban: "FR14...2606" }, { developer, client }), /does not match/);
  assert.throws(() => payeeFor({ kind: "Refund", short_iban: "FR76...0189" }, { developer, client }), /does not match/);
  assert.throws(() => payeeFor({ kind: "Developer", short_iban: "FR76...0189" }, { client }), /No registered developer/);
});

test("counterpart builds individual and corporate details", () => {
  assert.deepEqual(counterpart({ iban: "FR76 3000", firstName: "Ada", lastName: "Example", country: "FR" }).details, { firstName: "Ada", lastName: "Example", country: "FR" });
  assert.deepEqual(counterpart({ iban: "FR76", companyName: "Example Studio", country: "FR" }).details, { companyName: "Example Studio", country: "FR" });
});

test('verified own-account refunds use the own payout recipient variant', () => {
  const result = counterpart({ iban: 'EE31 0000', country: 'EE', own: true });
  assert.deepEqual(result.details, { own: true });
  assert.deepEqual(result.identifier, { standard: 'iban', iban: 'EE310000' });
});
