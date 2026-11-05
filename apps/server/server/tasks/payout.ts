import { randomBytes } from "node:crypto";
import { countrySpecs, isSEPACountry, isValidIBAN } from "ibantools";
import { hash, type Task } from "./domain.ts";

/** Private server-side data; only its salted commitment and masked label are public. */
export interface PayoutDetails {
  iban: string;
  firstName: string;
  lastName: string;
  country: string;
  salt: string;
}
export const shortIban = (iban: string) =>
  `${iban.slice(0, 4)}...${iban.slice(-4)}`;
export const payoutLabel = (p: PayoutDetails) =>
  `${p.firstName} ${p.lastName} · ${shortIban(p.iban)}`;
export const payoutCommitment = (developerId: number, p: PayoutDetails) =>
  hash({ developerId, ...p });

export function parsePayout(
  input: Record<string, unknown>,
  sandboxIbans: readonly string[] = [],
): PayoutDetails {
  const name = (key: string) => {
    const value = input[key];
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.trim().length > 100 ||
      /[\p{Cc}\p{Cf}]/u.test(value)
    )
      throw new Error("Enter the account holder's first and last name");
    return value.trim();
  };
  const iban =
    typeof input.iban === "string"
      ? input.iban.replace(/\s/g, "").toUpperCase()
      : "";
  if (
    (!isValidIBAN(iban, { allowQRIBAN: false }) &&
      !sandboxIbans.includes(iban)) ||
    !isSEPACountry(iban.slice(0, 2))
  )
    throw new Error("Enter a valid SEPA IBAN");
  const country =
    typeof input.country === "string" ? input.country.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(country) || !countrySpecs[country])
    throw new Error("Enter the account holder's two-letter country code");
  return {
    iban,
    firstName: name("firstName"),
    lastName: name("lastName"),
    country,
    salt: randomBytes(32).toString("hex"),
  };
}

export function payoutFor(t: Task): PayoutDetails {
  const p = t.payout;
  if (!p || !t.policy.payoutCommitment)
    throw new Error("The developer must save payout details before acceptance");
  if (
    hash(t.policy) !== t.policyHash ||
    payoutCommitment(t.policy.developerId, p) !== t.policy.payoutCommitment ||
    payoutLabel(p) !== t.policy.recipient
  )
    throw new Error("Payout destination integrity check failed");
  return p;
}

export function verifyTaskPayout(t: Task) {
  if(t.policy.paymentRail!=="base-usdc") { payoutFor(t); return; }
  if(!/^0x[0-9a-f]{40}$/.test(t.policy.recipient) || /^0x0{40}$/.test(t.policy.recipient) || t.policy.payoutCommitment!==hash({developerId:t.policy.developerId,rail:"base-usdc",address:t.policy.recipient}) || hash(t.policy)!==t.policyHash) throw new Error("Crypto payout destination integrity check failed");
}
