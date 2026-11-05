// Local JSON state. Holds personal data (full IBANs, names): keep it out of git and backed up
// encrypted in production.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Party } from "./logic.ts";

export interface BountyRecord {
  /** The assigned developer's payout account; absent until a developer is assigned. */
  developer?: Party;
  /** The client's refund account (the bounty's `refund_short_iban`). */
  client: Party;
  /** Sandbox demo only: move the profile's single IBAN to this bounty's address once linked. */
  moveIbanHere?: boolean;
  linked?: boolean;
}

export interface State {
  bounties: Record<string, BountyRecord>;
  /** Monerium issue orders already reported to the contract. */
  reportedOrders: string[];
  /** Payout id → Monerium redeem order id. */
  submitted: Record<string, string>;
  /** Payout id → hash of the NEAR transaction that marked it processed (explorer receipts). */
  processedTx?: Record<string, string>;
  /** Write-ahead marker: a timed-out redeem must be reconciled, never blindly resubmitted. */
  pendingSubmissions?: Record<string, { memo: string; at: string; requestId?: string; error?: string }>;
  /** Incremental-scan cursor: facts that never change once observed on-chain. */
  scan?: {
    /** Tracked bounties seen Closed or Cancelled (no more deposits or address links). */
    terminalBounties: number[];
    /** Payouts seen Processed (terminal). */
    donePayouts: number[];
    /** Payout id → bounty id (immutable once the payout exists). */
    payoutBounties: Record<string, number>;
  };
}

export class Store {
  state: State;

  constructor(private readonly file: string) {
    this.state = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as State)
      : { bounties: {}, reportedOrders: [], submitted: {} };
  }

  /** Atomic write. */
  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
