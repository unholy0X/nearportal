use near_sdk::json_types::U64;
use near_sdk::{near, AccountId};
use nearportal_common::assignment::Assignment;
use nearportal_common::roles::PendingRelayer;

/// Arguments of `create_bounty`. The caller (an allowlisted operator) becomes the client.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewBounty {
    pub funding_policy_hash: String,
    /// US cents, `1..=MAX_REWARD_CENTS`; paid as `reward_cents * 10_000` USDC units.
    pub reward_cents: U64,
    /// Delivery window per assignment; `None` means no deadline.
    pub delivery_seconds: Option<u32>,
    /// Client refund destination for a dispute refund, immutable after creation.
    pub refund_address: String,
    /// Must equal the address the MPC network derives for `get_escrow_path(bounty_id)`.
    pub escrow_evm_address: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BountyState {
    /// Waiting for the MPC network to confirm `escrow_evm_address`; can be retried.
    VerifyingAddress,
    AwaitingDeposit,
    /// `deposited_units >= reward_cents * 10_000`.
    Funded,
    Disputed,
    /// The single outgoing transaction is authorized (`payout` is set).
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutKind {
    Developer,
    /// Dispute outcome: all recorded deposits back to `refund_address`.
    Refund,
}

/// The only transaction the escrow address ever signs (nonce 0). Retries re-sign the same
/// bytes; fees cannot be replaced.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsdcPayout {
    pub kind: PayoutKind,
    pub recipient: String,
    pub amount_units: U64,
    /// Unsigned EIP-1559 transaction, `0x` hex.
    pub unsigned_tx: String,
    /// keccak256 of `unsigned_tx`, the digest signed by the MPC network.
    pub digest: String,
    /// `None` for a dispute outcome.
    pub evidence_hash: Option<String>,
    pub signature: Option<String>,
    pub signing: bool,
    pub attempt: u32,
    /// Unix seconds of the latest signature request.
    pub requested_at_secs: U64,
    /// Hash of the broadcast transaction, checked against `unsigned_tx` + `signature`.
    pub tx_hash: Option<String>,
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
    pub refund_address: String,
    pub escrow_evm_address: String,
    pub state: BountyState,
    /// All recorded deposits, including any surplus beyond the reward. Surplus is not
    /// refunded on chain after a developer payout (one transaction per address).
    pub deposited_units: U64,
    pub generation: u32,
    pub assignment: Option<Assignment>,
    pub payout: Option<UsdcPayout>,
}

impl Bounty {
    pub fn reward_units(&self) -> u64 {
        self.reward_cents.0 * nearportal_common::evm::USDC_UNITS_PER_CENT
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub bounty_id: String,
    pub units: u64,
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
    pub chain_id: U64,
    pub token: String,
    pub max_reward_cents: U64,
}
