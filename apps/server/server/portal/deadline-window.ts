import type { FixedView } from '../market/fixed.ts';

/** Small, public display projection. No wallet, PR commit or private agreement data. */
export function deadlineWindow(view: FixedView | null) {
  if (!view) return null;
  const a = view.assignment;
  return {
    deliveryHours: view.deliveryHours,
    serverNow: view.serverNow,
    settlement: view.settlement ? { processed: view.settlement.processed } : null,
    assignment: a ? {
      confirmed: a.confirmed,
      deadline: a.deadline,
      withdrawRequested: a.withdrawRequested,
      submission: a.submission ? { receivedAt: a.submission.receivedAt } : null,
    } : null,
  };
}
