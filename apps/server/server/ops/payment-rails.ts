import type { PaymentAdapter } from "../tasks/payments.ts";

/** An explicit USDC-only deployment must never load bank credentials or adapters. */
export function bankPaymentsEnabled(): boolean {
  const value = process.env.TASK_BANK_ENABLED;
  if (value !== undefined && value !== "0" && value !== "1")
    throw new Error("TASK_BANK_ENABLED must be 0 or 1");
  return value !== "0";
}

export const BANK_DISABLED_MESSAGE = "Bank payments are disabled on this deployment.";

export function disabledBankPayments(): PaymentAdapter {
  const denied = async (): Promise<never> => { throw new Error(BANK_DISABLED_MESSAGE); };
  return { prepare: denied, sync: denied, release: denied, dispute: denied, deposit: denied };
}
