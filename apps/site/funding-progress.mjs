export function fundingProgress(state) {
  if (state === 'Recorded') return { title: 'Deposit recorded', detail: 'The deposit is recorded on NEAR. Waiting for the bounty to update.', step: 3, busy: false, issue: false };
  if (state === 'NeedsReview' || state === 'Failed') return { title: state === 'Failed' ? 'Transfer needs attention' : 'Confirmation needs review', detail: 'This funding attempt is locked. Review its status before any further action.', step: -1, busy: false, issue: true };
  if (state === 'Recording') return { title: 'Securing the reward', detail: 'Transfer confirmed. Recording the deposit on NEAR.', step: 2, busy: true, issue: false };
  if (state === 'Pending' || state === 'Signed') return { title: 'Confirming your transfer', detail: 'Waiting for network confirmations. No additional payment is needed.', step: 1, busy: true, issue: false };
  if (state === 'Preparing') return { title: 'Preparing your transfer', detail: 'Checking the escrow and signing one exact-amount transfer.', step: 0, busy: true, issue: false };
  return { title: 'Checking funding status', detail: 'Restoring your funding progress. A second payment is locked.', step: 0, busy: true, issue: false };
}
