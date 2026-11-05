// Pure decision logic of the relayer. No I/O, fully unit-tested.

/** Monerium short form of an IBAN: first 4 characters, "...", last 4 (e.g. FR76...0189). */
export function shortIban(iban: string): string {
  const compact = iban.replace(/\s/g, "").toUpperCase();
  return `${compact.slice(0, 4)}...${compact.slice(-4)}`;
}

/** Parses a Monerium decimal amount ("720", "10.5", "0.05") into euro cents. */
export function eurToCents(amount: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!match) throw new Error(`Invalid EUR amount: ${amount}`);
  const euros = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  return euros * 100 + cents;
}

/**
 * Extracts the amount from a signed redeem message. The relayer sends exactly this string as the
 * order's `amount`, so it can never differ from what was signed.
 */
export function amountFromMessage(message: string): string {
  const match = /^Send EUR (\d+(?:\.\d{2})?) to [A-Z]{2}\d{2}\.\.\.[A-Z0-9]{4} at \S+$/.exec(message);
  if (!match?.[1]) throw new Error(`Unexpected redeem message: ${message}`);
  return match[1];
}

export type BountyState = "VerifyingAddress" | "AwaitingDeposit" | "Funded" | "Disputed" | "Closed" | "Cancelled";

/**
 * Whether an incoming Monerium issue order (SEPA in) can be reported to the contract. The
 * contract decides the allocation (reward first, the rest is surplus refunded to the client);
 * it refuses deposits only before the escrow address is verified or after it was rejected.
 */
export function acceptsDeposits(state: BountyState): boolean {
  return state !== "VerifyingAddress" && state !== "Cancelled";
}

export interface Party {
  /** Only set after confirming the destination belongs to this Monerium profile. */
  own?: boolean;
  iban: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  country: string;
}

/**
 * Finds the party a payout goes to. A developer payout pays the active assignment's recipient;
 * a dispute refund or a surplus refund pays the client. The signed short IBAN must match.
 */
export function payeeFor(payout: { kind: "Developer" | "Refund" | "SurplusRefund"; short_iban: string }, parties: { developer?: Party; client: Party }): Party {
  const payee = payout.kind === "Developer" ? parties.developer : parties.client;
  if (!payee) throw new Error(`No registered ${payout.kind === "Developer" ? "developer" : "client"} for payout to ${payout.short_iban}`);
  if (shortIban(payee.iban) !== payout.short_iban) {
    throw new Error(`Short IBAN ${payout.short_iban} does not match the registered ${payout.kind === "Developer" ? "developer" : "client"}`);
  }
  return payee;
}

/** Monerium counterpart object for a redeem order. */
export function counterpart(p: Party) {
  const details = p.own ? { own: true } : p.companyName
    ? { companyName: p.companyName, country: p.country }
    : { firstName: p.firstName ?? "", lastName: p.lastName ?? "", country: p.country };
  return { identifier: { standard: "iban" as const, iban: p.iban.replace(/\s/g, "") }, details };
}
