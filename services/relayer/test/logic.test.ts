import { test } from "node:test";
import assert from "node:assert/strict";
import { amountFromMessage, classifyIncoming, COOLING_OFF_MS, counterpart, eurToCents, payeeFor, shortIban, type JobView } from "../src/logic.ts";

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

const base: JobView = { state: "Signed", off_premises: true, signed_at_ns: 0, deposited_cents: 0, milestones: [{ amount_cents: 21_600 }, { amount_cents: 50_400 }] };

test("classifyIncoming respects the cooling-off period", () => {
  assert.equal(classifyIncoming(base, 72_000, COOLING_OFF_MS - 1), "excess");
  assert.equal(classifyIncoming(base, 72_000, COOLING_OFF_MS), "deposit");
  assert.equal(classifyIncoming({ ...base, off_premises: false }, 72_000, 0), "deposit");
});

test("classifyIncoming sends overpayments and late money to excess", () => {
  assert.equal(classifyIncoming({ ...base, off_premises: false }, 72_001, 0), "excess");
  assert.equal(classifyIncoming({ ...base, state: "Funded" }, 1, 0), "excess");
  assert.equal(classifyIncoming({ ...base, state: "VerifyingAddress" }, 1, 0), "ignore");
});

test("payeeFor requires exactly one matching party", () => {
  // Monerium sandbox example IBAN; use one issued to your own Monerium sandbox account.
  const artisan = { iban: "FR7630006000011234567890189", firstName: "Marc", lastName: "Durand", country: "FR" };
  const client = { iban: "FR1420041010050500013M02606", firstName: "Josette", lastName: "Martin", country: "FR" };
  assert.equal(payeeFor("FR76...0189", artisan, client), artisan);
  assert.equal(payeeFor("FR14...2606", artisan, client), client);
  assert.throws(() => payeeFor("DE89...3000", artisan, client));
  assert.throws(() => payeeFor("FR76...0189", artisan, { ...client, iban: artisan.iban }));
});

test("counterpart builds individual and corporate details", () => {
  assert.deepEqual(counterpart({ iban: "FR76 3000", firstName: "Marc", lastName: "Durand", country: "FR" }).details, { firstName: "Marc", lastName: "Durand", country: "FR" });
  assert.deepEqual(counterpart({ iban: "FR76", companyName: "Durand Peinture", country: "FR" }).details, { companyName: "Durand Peinture", country: "FR" });
});

test('verified own-account refunds use the own payout recipient variant', () => {
  const result = counterpart({ iban: 'EE31 0000', country: 'EE', own: true });
  assert.deepEqual(result.details, { own: true });
  assert.deepEqual(result.identifier, { standard: 'iban', iban: 'EE310000' });
});
