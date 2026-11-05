/** Exact method scopes for fresh worker accounts. The creator needs its own low-balance
 * full-access account because escrow creation attaches a storage deposit. Owner keys stay offline. */
const assignments=['assign_developer','record_submission','expire_assignment','withdraw_assignment','settle_bounty','open_dispute','retry_address_check'];
export const VERIFIER_METHODS={bank:[...assignments],usdc:[...assignments,'retry_payout_signature']};
export const RELAYER_METHODS={bank:['record_deposit','link_escrow_address','mark_payout_processed','retry_payout'],usdc:['record_deposit','mark_payout_processed']};
