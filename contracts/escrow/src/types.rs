use near_sdk::json_types::U64;
use near_sdk::{near, AccountId};
use nearportal_common::assignment::Assignment;
use nearportal_common::roles::PendingRelayer;

pub type BountyId = u64;
pub type PayoutId = u64;

/// Arguments of `create_bounty`. The caller (an allowlisted operator) becomes the client.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct NewBounty {
    pub funding_policy_hash: String,
    /// Euro cents, `1..=MAX_REWARD_CENTS`.
    pub reward_cents: U64,
    /// Delivery window per assignment; `None` means no deadline.
    pub delivery_seconds: Option<u32>,
    /// Client refund destination, immutable after creation.
    pub refund_short_iban: String,
    /// Must equal the address the MPC network derives for `get_escrow_path(next_bounty_id)`.
    pub escrow_evm_address: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BountyState {
    /// Waiting for the MPC network to confirm `escrow_evm_address`.
    VerifyingAddress,
    AwaitingDeposit,
    /// `deposited_cents == reward_cents`.
    Funded,
    Disputed,
    /// Settled (developer payout or dispute outcome scheduled).
    Closed,
    /// The declared escrow address is not the derived one.
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkState {
    None,
    Signing,
    /// Verified `0x{r}{s}{v}` over the Monerium ownership message.
    Signed(String),
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Bounty {
    pub client: AccountId,
    /// Frozen at creation; a later `set_verifier` does not change it.
    pub verifier: AccountId,
    pub funding_policy_hash: String,
    pub reward_cents: U64,
    pub delivery_seconds: Option<u32>,
    pub refund_short_iban: String,
    pub escrow_path: String,
    pub escrow_evm_address: String,
    pub state: BountyState,
    pub link: LinkState,
    pub created_at_ns: U64,
    /// Deposits allocated to the reward; never above `reward_cents`.
    pub deposited_cents: U64,
    /// Part of `deposited_cents` committed to a scheduled payout.
    pub committed_cents: U64,
    /// Money received beyond the reward; it only ever goes back to the client.
    pub surplus_recorded_cents: U64,
    pub surplus_refunded_cents: U64,
    /// Payouts of this bounty not yet processed.
    pub open_payouts: u32,
    /// Generation of the latest assignment (0 before the first one).
    pub generation: u32,
    pub assignment: Option<Assignment>,
    /// The single settlement payout (developer payout or dispute refund).
    pub settlement_payout_id: Option<U64>,
    pub settlement_evidence_hash: Option<String>,
}

impl Bounty {
    pub fn uncommitted_cents(&self) -> u64 {
        self.deposited_cents.0 - self.committed_cents.0
    }

    /// Funded, not settled, not disputed, no payout in flight.
    pub fn is_idle_funded(&self) -> bool {
        self.state == BountyState::Funded && self.open_payouts == 0
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutKind {
    Developer,
    /// Dispute outcome: uncommitted deposit back to the client.
    Refund,
    SurplusRefund,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutState {
    Signing,
    /// Verified signature available; the relayer submits the order to Monerium.
    Signed,
    SignFailed,
    Processed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Payout {
    pub bounty_id: U64,
    pub kind: PayoutKind,
    pub amount_cents: U64,
    /// Destination frozen at scheduling; retries reuse it.
    pub short_iban: String,
    /// Timestamp embedded in `message` (Unix seconds).
    pub message_unix_secs: U64,
    pub message: String,
    /// EIP-191 digest of `message`, hex.
    pub payload_hash: String,
    pub signature: Option<String>,
    pub state: PayoutState,
    pub failure_reason: Option<String>,
    /// Set by the owner after checking off chain that an expired message was never executed.
    pub resign_authorized: bool,
    /// Incremented on every signature request; stale MPC callbacks are ignored.
    pub attempt: u32,
    pub monerium_order_id: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub owner: AccountId,
    pub relayer: AccountId,
    pub pending_relayer: Option<PendingRelayer>,
    pub verifier: AccountId,
    pub operators: Vec<AccountId>,
    pub mpc_contract: AccountId,
    pub mpc_path: String,
    pub paused: bool,
    pub next_bounty_id: U64,
    pub next_payout_id: U64,
    pub max_reward_cents: U64,
}
