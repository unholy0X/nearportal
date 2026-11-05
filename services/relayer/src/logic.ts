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

export type JobState = "VerifyingAddress" | "AwaitingClient" | "Signed" | "Funded" | "Disputed" | "Closed" | "Cancelled";

export interface JobView {
  state: JobState;
  off_premises: boolean;
  signed_at_ns: number | null;
  deposited_cents: number;
  milestones: { amount_cents: number }[];
}

export const COOLING_OFF_MS = 7 * 24 * 3600 * 1000;

/**
 * Decides how an incoming Monerium issue order (SEPA in) is reported to the contract:
 * as a deposit when the contract will accept it, otherwise as excess for the mediator.
 */
export function classifyIncoming(job: JobView, amountCents: number, nowMs: number): "deposit" | "excess" | "ignore" {
  if (job.state === "VerifyingAddress") return "ignore";
  if (job.state !== "Signed") return "excess";
  if (job.off_premises) {
    const signedAtMs = (job.signed_at_ns ?? 0) / 1e6;
    if (nowMs < signedAtMs + COOLING_OFF_MS) return "excess";
  }
  const escrow = job.milestones.reduce((sum, m) => sum + m.amount_cents, 0);
  return job.deposited_cents + amountCents <= escrow ? "deposit" : "excess";
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

/** Finds which party a payout goes to by matching the signed short IBAN. */
export function payeeFor(shortTarget: string, artisan: Party, client: Party): Party {
  const matches = [artisan, client].filter((p) => shortIban(p.iban) === shortTarget);
  if (matches.length !== 1) {
    throw new Error(`Short IBAN ${shortTarget} matches ${matches.length} known parties`);
  }
  return matches[0]!;
}

/** Monerium counterpart object for a redeem order. */
export function counterpart(p: Party) {
  const details = p.own ? { own: true } : p.companyName
    ? { companyName: p.companyName, country: p.country }
    : { firstName: p.firstName ?? "", lastName: p.lastName ?? "", country: p.country };
  return { identifier: { standard: "iban" as const, iban: p.iban.replace(/\s/g, "") }, details };
}
