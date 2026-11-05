//! Panic messages of both contracts. Off-chain callers match these strings, so they are part
//! of the ABI (see `docs/CONTRACT-ABI-CHANGES.md`).

// Access control.
pub const ONLY_OWNER: &str = "Only the owner";
pub const ONLY_RELAYER: &str = "Only the relayer";
pub const ONLY_VERIFIER: &str = "Only the verifier";
pub const ONLY_OPERATOR: &str = "Only an operator";
pub const ONLY_CLIENT_OR_VERIFIER: &str = "Only the client or the verifier";
pub const ONLY_CLIENT_OR_RELAYER: &str = "Only the client or the relayer";
pub const ONLY_CLIENT_OWNER_OR_RELAYER: &str = "Only the client, the owner or the relayer";
pub const ONLY_VERIFIER_OR_OWNER: &str = "Only the verifier or the owner";
pub const OPERATOR_NOT_INDEPENDENT: &str = "Operator must be independent";
pub const VERIFIER_NOT_INDEPENDENT: &str = "Verifier must be independent";
pub const OWNER_NOT_INDEPENDENT: &str = "Owner must be independent";
pub const PAUSED: &str = "Contract is paused";
pub const TESTNET_ONLY: &str = "Testnet only";
pub const RELAYER_TIME_LOCKED: &str = "Relayer change is time-locked";
pub const NO_PENDING_RELAYER: &str = "No pending relayer";

// Missing records.
pub const NO_SUCH_BOUNTY: &str = "No such bounty";
pub const NO_SUCH_PAYOUT: &str = "No such payout";

// Input validation.
pub const INVALID_MPC_PATH: &str = "Invalid mpc_path";
pub const INVALID_BOUNTY_ID: &str = "Invalid bounty id";
pub const INVALID_REWARD: &str = "Invalid reward";
pub const INVALID_FUNDING_POLICY_HASH: &str = "Invalid funding policy hash";
pub const INVALID_ASSIGNMENT_HASH: &str = "Invalid assignment hash";
pub const INVALID_EVIDENCE_HASH: &str = "Invalid evidence hash";
pub const INVALID_DELIVERY_WINDOW: &str = "Invalid delivery window";
pub const INVALID_SHORT_IBAN: &str = "Invalid short IBAN";
pub const INVALID_ESCROW_ADDRESS: &str = "Invalid escrow EVM address";
pub const INVALID_REFUND_ADDRESS: &str = "Invalid refund address";
pub const INVALID_RECIPIENT: &str = "Invalid recipient";
pub const RECIPIENT_MATCHES_REFUND: &str = "Recipient matches client refund";
pub const INVALID_DEVELOPER: &str = "Invalid developer identity";
pub const INVALID_COMMIT: &str = "Invalid GitHub commit";
pub const INVALID_ORDER_ID: &str = "Invalid order id";
pub const INVALID_DEPOSIT_RECEIPT: &str = "Invalid deposit receipt";
pub const INVALID_PROCESSED_RECEIPT: &str = "Invalid processed receipt";
pub const AMOUNT_NOT_POSITIVE: &str = "Amount must be positive";
pub const GAS_FEE_LIMIT: &str = "Gas fee limit exceeded";

// Bounty lifecycle.
pub const BOUNTY_ALREADY_EXISTS: &str = "Bounty already exists";
pub const ADDRESS_NOT_VERIFIED: &str = "Escrow address not verified";
pub const ADDRESS_ALREADY_VERIFIED: &str = "Escrow address already verified";
pub const LINK_NOT_AVAILABLE: &str = "Escrow address not verified or bounty closed";
pub const LINK_ALREADY_REQUESTED: &str = "Link signature already requested";
pub const FUNDED_UNSETTLED_REQUIRED: &str = "Funded unsettled bounty required";
pub const NOTHING_TO_DISPUTE: &str = "Nothing deposited to dispute";
pub const NO_OPEN_DISPUTE: &str = "No open dispute";
pub const SETTLEMENT_ALREADY_AUTHORIZED: &str = "Settlement already authorized";
pub const ORDER_ALREADY_RECORDED: &str = "Order already recorded";
pub const RECEIPT_ALREADY_CONSUMED: &str = "Receipt already consumed";

// Assignment and deadline.
pub const DEVELOPER_ALREADY_BOUND: &str = "Developer already bound";
pub const GENERATION_MISMATCH: &str = "Assignment generation mismatch";
pub const ASSIGNMENT_HASH_MISMATCH: &str = "Assignment hash mismatch";
pub const NO_ACTIVE_ASSIGNMENT: &str = "No active assignment";
pub const SUBMISSION_MISSED_DEADLINE: &str = "Submission missed deadline";
pub const RELAY_GRACE_EXPIRED: &str = "Submission relay grace expired";
pub const INVALID_OBSERVATION_TIME: &str = "Invalid submission observation time";
pub const NO_DEADLINE: &str = "Assignment has no deadline";
pub const WINDOW_STILL_OPEN: &str = "Delivery or relay window still open";
pub const SUBMITTED_WORK_CANNOT_EXPIRE: &str = "Submitted work cannot expire";
pub const TIMELY_SUBMISSION_REQUIRED: &str = "Exact timely submission required";

// Payouts and MPC signing.
pub const PAYOUT_NOT_POSITIVE: &str = "Payout must be positive";
pub const PAYOUT_EXCEEDS_UNCOMMITTED: &str = "Payout exceeds uncommitted deposit";
pub const PAYOUT_CANNOT_BE_RESIGNED: &str = "Payout cannot be signed again";
pub const PREVIOUS_MESSAGE_NOT_EXPIRED: &str = "Previous message has not expired yet";
pub const MESSAGE_NOT_EXPIRED: &str = "Message has not expired yet";
pub const PAYOUT_NOT_SIGNED: &str = "Payout is not signed";
pub const PAYOUT_NOT_SIGNED_OR_FAILED: &str = "Payout is not signed or failed";
pub const PAYOUT_NOT_SIGNING: &str = "Payout is not signing";
pub const SIGNING_NOT_TIMED_OUT: &str = "Signing has not timed out yet";
pub const SIGNATURE_RETRY_NOT_READY: &str = "Signature retry not ready";
pub const PAYOUT_ALREADY_PROCESSED: &str = "Payout already processed";

// Gas, storage and arithmetic.
pub const NOT_ENOUGH_GAS: &str = "Not enough gas: attach 300 Tgas";
pub const INSUFFICIENT_STORAGE_DEPOSIT: &str = "Insufficient storage deposit";
pub const OVERFLOW: &str = "Overflow";
pub const SERIALIZATION: &str = "Serialization";
